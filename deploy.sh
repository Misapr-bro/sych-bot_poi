#!/bin/bash
set -e

echo "🔄 Starting deployment..."

cd /root/sych-bot_poi/
echo "📂 Pulling from GitHub..."
git checkout anna
git pull origin anna

echo "🐳 Rebuilding Docker..."
docker-compose down
docker-compose up -d --build

echo "✅ Deployment complete!"
echo "📋 Logs:"
docker logs --tail 50 sych-bot