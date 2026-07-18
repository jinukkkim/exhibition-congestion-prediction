#!/usr/bin/env bash
# Runs on the production server (via SSH from the deploy workflow) to bring
# it in sync with main and restart the backend.
set -euo pipefail

cd /home/ubuntu/exhibition-traffic

git fetch origin
git reset --hard HEAD
git checkout -B main origin/main

cd backend
.venv/bin/pip install -e . --quiet
sudo systemctl restart exhibition-backend.service

cd ../frontend
npm ci
npm run build
sudo rsync -a --delete dist/ /var/www/exhibition-traffic/
