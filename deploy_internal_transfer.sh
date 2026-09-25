#!/bin/bash
set -e

echo "=== Deploying frontend: Internal Transfer changes ==="

cd /home/rocky/app/cmx_dialer

echo "--- git pull ---"
git pull

echo "--- removing old, now-unused modal file (if it still exists) ---"
rm -f frontend/src/modals/TransferExtensionModal.jsx

cd frontend

echo "--- npm run build ---"
npm run build

echo "--- verifying the new build actually contains the fix ---"
if ! grep -l "Internal Transfer" dist/assets/*.js > /dev/null 2>&1; then
  echo "ERROR: 'Internal Transfer' not found in the new build. Aborting before copying."
  exit 1
fi
echo "Confirmed: build contains the Internal Transfer button text."

echo "--- copying to served directory ---"
sudo cp -r dist/* /var/www/dialer-frontend/

echo "--- verifying the SERVED copy also contains the fix ---"
if ! grep -l "Internal Transfer" /var/www/dialer-frontend/assets/*.js > /dev/null 2>&1; then
  echo "ERROR: 'Internal Transfer' not found in the served copy after cp. Something went wrong."
  exit 1
fi
echo "Confirmed: served copy contains the Internal Transfer button text."

echo "=== Deploy complete. Hard-refresh the browser and test. ==="
