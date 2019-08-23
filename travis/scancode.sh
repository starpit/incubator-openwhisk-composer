#!/bin/bash

#
# Licensed to the Apache Software Foundation (ASF) under one or more
# contributor license agreements.  See the NOTICE file distributed with
# this work for additional information regarding copyright ownership.
# The ASF licenses this file to You under the Apache License, Version 2.0
# (the "License"); you may not use this file except in compliance with
# the License.  You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
#

set -e

SCRIPTDIR=$(cd $(dirname "$0") && pwd)
ROOTDIR="$SCRIPTDIR/../"
HOMEDIR="$SCRIPTDIR/../../"
UTIL_DIR="$HOMEDIR/openwhisk-utilities"

# clone OpenWhisk utilities repo. in order to run scanCode.py
cd $HOMEDIR
git clone https://github.com/apache/openwhisk-utilities.git

# run scancode
cd $UTIL_DIR
scancode/scanCode.py --config scancode/ASF-Release.cfg $ROOTDIR
