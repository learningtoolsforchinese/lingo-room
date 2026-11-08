#!/bin/sh
# Stamp a version on every local CSS/JS link so browsers load fresh files after an update.
#   sh scripts/set-version.sh 0.8.0
set -e
cd "$(dirname "$0")/.."
V="$1"
[ -n "$V" ] || { echo "usage: sh scripts/set-version.sh X.Y.Z"; exit 1; }
for f in *.html *.js; do
  perl -pi -e '
    s#(href="style\.css)(\?v=[^"]*)?"#$1?v='"$V"'"#g;
    s#(src="(?:host|student|history)\.js)(\?v=[^"]*)?"#$1?v='"$V"'"#g;
    s#(from "\./(?:common|board|firebase-config)\.js)(\?v=[^"]*)?"#$1?v='"$V"'"#g;
  ' "$f"
done
echo "Version set to $V"
