set -e
mkdir -p /app
tar xzf /mnt/runner/runner.tgz -C /app
cd /app
echo "## Seed run 1"
node tools/seed/main.ts --target cloud --confirm-account "$COSMOS_ACCOUNT_NAME"
echo "## Seed run 2 (repeat, must not overwrite)"
node tools/seed/main.ts --target cloud --confirm-account "$COSMOS_ACCOUNT_NAME"
echo "## Proof"
node tools/azure/prove.ts
