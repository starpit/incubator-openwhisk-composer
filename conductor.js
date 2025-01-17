/*
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements.  See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to You under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with
 * the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/* eslint no-eval: 0 */

'use strict'

const { minify } = require('terser')

// read conductor version number
const version = require('./package.json').version

// synthesize conductor action code from composition
function generate ({ name, composition, ast, version: composer, annotations = [] }, debug, kind = 'nodejs:default', timeout = 60000) {
  let code = `// generated by composer v${composer} and conductor v${version}\n\nconst composition = ${JSON.stringify(composition, null, 4)}\n\n// do not edit below this point\n\n` +
    minify(`const main=(${main})(composition)`, { output: { max_line_len: 127 } }).code
  if (debug) code = `process.env.DEBUG='${debug}'\n\n` + code
  annotations = annotations.concat([
    { key: 'conductor', value: ast },
    { key: 'composerVersion', value: composer },
    { key: 'conductorVersion', value: version },
    { key: 'provide-api-key', value: true }])
  return { name, action: { exec: { kind, code }, annotations, limits: { timeout } } }
}

module.exports = { generate }

// runtime code
function main (composition) {
  const openwhisk = require('openwhisk')
  const redis = require('redis')
  const uuid = require('uuid').v4
  let wsk
  let db
  const expiration = 86400 // expire redis key after a day

  function live (id) { return `composer/fork/${id}` }
  function done (id) { return `composer/join/${id}` }

  function createRedisClient (p) {
    const client = redis.createClient(p.s.redis.uri, p.s.redis.ca ? { tls: { ca: Buffer.from(p.s.redis.ca, 'base64').toString('binary') } } : {})
    const noop = () => { }
    let handler = noop
    client.on('error', error => handler(error))
    require('redis-commands').list.forEach(f => {
      client[`${f}Async`] = function () {
        let failed = false
        return new Promise((resolve, reject) => {
          handler = error => {
            handler = noop
            failed = true
            reject(error)
          }
          client[f](...arguments, (error, result) => {
            handler = noop
            return error ? reject(error) : resolve(result)
          })
        }).catch(error => {
          if (failed) client.end(true)
          return Promise.reject(error)
        })
      }
    })
    return client
  }

  const isObject = obj => typeof obj === 'object' && obj !== null && !Array.isArray(obj)

  const needleOptions = (/needle<([^>]*)>/.exec(process.env.DEBUG || '') || [])[1]

  function invoke (req) {
    try {
      if (needleOptions) req = Object.assign({}, req, JSON.parse(needleOptions))
    } catch (err) {
      console.err(`Ignoring invalid needle options: ${needleOptions}`)
    }
    return wsk.actions.invoke(req)
  }

  function fork ({ p, node, index }, array, it) {
    const saved = p.params // save params
    p.s.state = index + node.return // return state
    p.params = { value: [] } // return value
    if (array.length === 0) return
    if (typeof p.s.redis !== 'object' || typeof p.s.redis.uri !== 'string' || (typeof p.s.redis.ca !== 'string' && typeof p.s.redis.ca !== 'undefined')) {
      p.params = { error: 'Parallel combinator requires a properly configured redis instance' }
      console.error(p.params.error)
      return
    }
    const stack = [{ marker: true }].concat(p.s.stack)
    const barrierId = uuid()
    console.log(`barrierId: ${barrierId}, spawning: ${array.length}`)
    if (!wsk) wsk = openwhisk(p.s.openwhisk)
    if (!db) db = createRedisClient(p)
    return db.lpushAsync(live(barrierId), 42) // push marker
      .then(() => db.expireAsync(live(barrierId), expiration))
      .then(() => Promise.all(array.map((item, position) => {
        const params = it(saved, item) // obtain combinator-specific params for branch invocation
        params.$composer.stack = stack
        params.$composer.redis = p.s.redis
        params.$composer.openwhisk = p.s.openwhisk
        params.$composer.join = { barrierId, position, count: array.length }
        return invoke({ name: process.env.__OW_ACTION_NAME, params }) // invoke branch
          .then(({ activationId }) => { console.log(`barrierId: ${barrierId}, spawned position: ${position} with activationId: ${activationId}`) })
      }))).then(() => collect(p, barrierId), error => {
        console.error(error.body || error)
        p.params = { error: `Parallel combinator failed to invoke a composition at AST node root${node.parent} (see log for details)` }
        return db.delAsync(live(barrierId), done(barrierId)) // delete keys
          .then(() => {
            inspect(p)
            return step(p)
          })
      })
  }

  // compile ast to fsm
  const compiler = {
    sequence (parent, node) {
      return [{ parent, type: 'pass' }, ...compile(parent, ...node.components)]
    },

    action (parent, node) {
      return [{ parent, type: 'action', name: node.name }]
    },

    async (parent, node) {
      const body = [...compile(parent, ...node.components)]
      return [{ parent, type: 'async', return: body.length + 2 }, ...body, { parent, type: 'stop' }, { parent, type: 'pass' }]
    },

    function (parent, node) {
      return [{ parent, type: 'function', exec: node.function.exec }]
    },

    finally (parent, node) {
      const finalizer = compile(parent, node.finalizer)
      const fsm = [{ parent, type: 'try' }, ...compile(parent, node.body), { parent, type: 'exit' }, ...finalizer]
      fsm[0].catch = fsm.length - finalizer.length
      return fsm
    },

    let (parent, node) {
      return [{ parent, type: 'let', let: node.declarations }, ...compile(parent, ...node.components), { parent, type: 'exit' }]
    },

    mask (parent, node) {
      return [{ parent, type: 'let', let: null }, ...compile(parent, ...node.components), { parent, type: 'exit' }]
    },

    try (parent, node) {
      const handler = [...compile(parent, node.handler), { parent, type: 'pass' }]
      const fsm = [{ parent, type: 'try' }, ...compile(parent, node.body), { parent, type: 'exit' }, ...handler]
      fsm[0].catch = fsm.length - handler.length
      fsm[fsm.length - handler.length - 1].next = handler.length
      return fsm
    },

    if_nosave (parent, node) {
      const consequent = compile(parent, node.consequent)
      const alternate = [...compile(parent, node.alternate), { parent, type: 'pass' }]
      const fsm = [{ parent, type: 'pass' }, ...compile(parent, node.test), { parent, type: 'choice', then: 1, else: consequent.length + 1 }, ...consequent, ...alternate]
      fsm[fsm.length - alternate.length - 1].next = alternate.length
      return fsm
    },

    while_nosave (parent, node) {
      const body = compile(parent, node.body)
      const fsm = [{ parent, type: 'pass' }, ...compile(parent, node.test), { parent, type: 'choice', then: 1, else: body.length + 1 }, ...body, { parent, type: 'pass' }]
      fsm[fsm.length - 2].next = 2 - fsm.length
      return fsm
    },

    dowhile_nosave (parent, node) {
      const fsm = [{ parent, type: 'pass' }, ...compile(parent, node.body), ...compile(parent, node.test), { parent, type: 'choice', else: 1 }, { parent, type: 'pass' }]
      fsm[fsm.length - 2].then = 2 - fsm.length
      return fsm
    },

    parallel (parent, node) {
      const tasks = node.components.map(task => [...compile(parent, task), { parent, type: 'stop' }])
      const fsm = [{ parent, type: 'parallel' }, ...tasks.reduce((acc, cur) => { acc.push(...cur); return acc }, []), { parent, type: 'pass' }]
      fsm[0].return = fsm.length - 1
      fsm[0].tasks = tasks.reduce((acc, cur) => { acc.push(acc[acc.length - 1] + cur.length); return acc }, [1]).slice(0, -1)
      return fsm
    },

    map (parent, node) {
      const tasks = compile(parent, ...node.components)
      return [{ parent, type: 'map', return: tasks.length + 2 }, ...tasks, { parent, type: 'stop' }, { parent, type: 'pass' }]
    },

    dynamic (parent, node) {
      return [{ parent, type: 'dynamic' }]
    }
  }

  function compile (parent, node) {
    if (arguments.length === 1) return [{ parent, type: 'empty' }]
    if (arguments.length === 2) {
      const fsm = compiler[node.type](node.path || parent, node)
      if (node.path !== undefined) fsm[0].path = node.path
      return fsm
    }
    return Array.prototype.slice.call(arguments, 1).reduce((fsm, node) => { fsm.push(...compile(parent, node)); return fsm }, [])
  }

  const fsm = compile('', composition)

  const conductor = {
    choice ({ p, node, index }) {
      p.s.state = index + (p.params.value ? node.then : node.else)
    },

    try ({ p, node, index }) {
      p.s.stack.unshift({ catch: index + node.catch })
    },

    let ({ p, node, index }) {
      p.s.stack.unshift({ let: JSON.parse(JSON.stringify(node.let)) })
    },

    exit ({ p, node, index }) {
      if (p.s.stack.length === 0) return internalError(`pop from an empty stack`)
      p.s.stack.shift()
    },

    action ({ p, node, index }) {
      return { method: 'action', action: node.name, params: p.params, state: { $composer: p.s } }
    },

    function ({ p, node, index }) {
      return Promise.resolve().then(() => run(node.exec.code, p))
        .catch(error => {
          console.error(error)
          return { error: `Function combinator threw an exception at AST node root${node.parent} (see log for details)` }
        })
        .then(result => {
          if (typeof result === 'function') result = { error: `Function combinator evaluated to a function type at AST node root${node.parent}` }
          // if a function has only side effects and no return value, return params
          p.params = JSON.parse(JSON.stringify(result === undefined ? p.params : result))
          inspect(p)
          return step(p)
        })
    },

    empty ({ p, node, index }) {
      inspect(p)
    },

    pass ({ p, node, index }) {
    },

    async ({ p, node, index, inspect, step }) {
      p.params.$composer = { state: p.s.state, stack: [{ marker: true }].concat(p.s.stack), redis: p.s.redis, openwhisk: p.s.openwhisk }
      p.s.state = index + node.return
      if (!wsk) wsk = openwhisk(p.s.openwhisk)
      return invoke({ name: process.env.__OW_ACTION_NAME, params: p.params })
        .then(response => ({ method: 'async', activationId: response.activationId, sessionId: p.s.session }), error => {
          console.error(error) // invoke failed
          return { error: `Async combinator failed to invoke composition at AST node root${node.parent} (see log for details)` }
        })
        .then(result => {
          p.params = result
          inspect(p)
          return step(p)
        })
    },

    stop ({ p, node, index, inspect, step }) {
      p.s.state = -1
    },

    parallel ({ p, node, index }) {
      return fork({ p, node, index }, node.tasks, (input, branch) => {
        const params = Object.assign({}, input) // clone
        params.$composer = { state: index + branch }
        return params
      })
    },

    map ({ p, node, index }) {
      return fork({ p, node, index }, p.params.value || [], (input, branch) => {
        const params = isObject(branch) ? branch : { value: branch } // wrap
        params.$composer = { state: index + 1 }
        return params
      })
    },

    dynamic ({ p, node, index }) {
      if (p.params.type !== 'action' || typeof p.params.name !== 'string' || typeof p.params.params !== 'object') {
        p.params = { error: `Incorrect use of the dynamic combinator at AST node root${node.parent}` }
        inspect(p)
      } else {
        return { method: 'action', action: p.params.name, params: p.params.params, state: { $composer: p.s } }
      }
    }
  }

  function finish (p) {
    return p.params.error ? p.params : { params: p.params }
  }

  function collect (p, barrierId) {
    if (!db) db = createRedisClient(p)
    const timeout = Math.max(Math.floor((process.env.__OW_DEADLINE - new Date()) / 1000) - 5, 1)
    console.log(`barrierId: ${barrierId}, waiting with timeout: ${timeout}s`)
    return db.brpopAsync(done(barrierId), timeout) // pop marker
      .then(marker => {
        console.log(`barrierId: ${barrierId}, done waiting`)
        if (marker !== null) {
          return db.lrangeAsync(done(barrierId), 0, -1)
            .then(result => result.map(JSON.parse).map(({ position, params }) => { p.params.value[position] = params }))
            .then(() => db.delAsync(live(barrierId), done(barrierId))) // delete keys
            .then(() => {
              inspect(p)
              return step(p)
            })
        } else { // timeout
          p.s.collect = barrierId
          console.log(`barrierId: ${barrierId}, handling timeout`)
          return { method: 'action', action: '/whisk.system/utils/echo', params: p.params, state: { $composer: p.s } }
        }
      })
  }

  const internalError = error => Promise.reject(error) // terminate composition execution and record error

  // wrap params if not a dictionary, branch to error handler if error
  function inspect (p) {
    if (!isObject(p.params)) p.params = { value: p.params }
    if (p.params.error !== undefined) {
      p.params = { error: p.params.error } // discard all fields but the error field
      p.s.state = -1 // abort unless there is a handler in the stack
      while (p.s.stack.length > 0 && !p.s.stack[0].marker) {
        if ((p.s.state = p.s.stack.shift().catch || -1) >= 0) break
      }
    }
  }

  // run function f on current stack
  function run (f, p) {
    // handle let/mask pairs
    const view = []
    let n = 0
    for (let frame of p.s.stack) {
      if (frame.let === null) {
        n++
      } else if (frame.let !== undefined) {
        if (n === 0) {
          view.push(frame)
        } else {
          n--
        }
      }
    }

    // update value of topmost matching symbol on stack if any
    function set (symbol, value) {
      const element = view.find(element => element.let !== undefined && element.let[symbol] !== undefined)
      if (element !== undefined) element.let[symbol] = JSON.parse(JSON.stringify(value))
    }

    // collapse stack for invocation
    const env = view.reduceRight((acc, cur) => cur.let ? Object.assign(acc, cur.let) : acc, {})
    let main = '(function(){try{const require=arguments[2];'
    for (const name in env) main += `var ${name}=arguments[1]['${name}'];`
    main += `return eval((function(){return(${f})})())(arguments[0])}finally{`
    for (const name in env) main += `arguments[1]['${name}']=${name};`
    main += '}})'
    try {
      return (1, eval)(main)(p.params, env, require)
    } finally {
      for (const name in env) set(name, env[name])
    }
  }

  function step (p) {
    // final state, return composition result
    if (p.s.state < 0 || p.s.state >= fsm.length) {
      console.log(`Entering final state`)
      console.log(JSON.stringify(p.params))
      if (p.s.join) {
        if (!db) db = createRedisClient(p)
        return db.lpushxAsync(live(p.s.join.barrierId), JSON.stringify({ position: p.s.join.position, params: p.params })).then(count => { // push only if marker is present
          return (count > p.s.join.count ? db.renameAsync(live(p.s.join.barrierId), done(p.s.join.barrierId)) : Promise.resolve())
        }).then(() => {
          p.params = { method: 'join', sessionId: p.s.session, barrierId: p.s.join.barrierId, position: p.s.join.position }
        })
      }
      return
    }

    // process one state
    const node = fsm[p.s.state] // json definition for index state
    if (node.path !== undefined) console.log(`Entering composition${node.path}`)
    const index = p.s.state // current state
    p.s.state = p.s.state + (node.next || 1) // default next state
    if (typeof conductor[node.type] !== 'function') return internalError(`unexpected "${node.type}" combinator`)
    return conductor[node.type]({ p, index, node, inspect, step }) || step(p)
  }

  // do invocation
  return (params) => {
    // extract parameters
    const $composer = params.$composer || {}
    delete params.$composer
    $composer.session = $composer.session || process.env.__OW_ACTIVATION_ID

    // current state
    const p = { s: Object.assign({ state: 0, stack: [], resuming: true }, $composer), params }

    // step and catch all errors
    return Promise.resolve().then(() => {
      if (typeof p.s.state !== 'number') return internalError('state parameter is not a number')
      if (!Array.isArray(p.s.stack)) return internalError('stack parameter is not an array')

      if (p.s.collect) { // waiting on parallel branches
        const barrierId = p.s.collect
        delete p.s.collect
        return collect(p, barrierId)
      }

      if ($composer.resuming) inspect(p) // handle error objects when resuming

      return step(p)
    }).catch(error => {
      const message = (typeof error.error === 'string' && error.error) || error.message || (typeof error === 'string' && error)
      p.params = { error: message ? `Internal error: ${message}` : 'Internal error' }
    }).then(params => params || finish(p)) // params is defined iff execution will be resumed
  }
}
