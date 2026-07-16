#!/bin/bash

# Exit immediately if a command exits with a non-zero status
set -e

echo "========================================="
echo "🚀 Starting your work session..."
echo "========================================="

# 1. Check for uncommitted changes and stash them safely
if [ -n "$(git status --porcelain)" ]; then
    echo "📦 Found uncommitted changes. Stashing them temporarily..."
    git stash -u
    STASHED=true
else
    STASHED=false
fi

# 2. Get the latest code from the remote repository
echo "🔄 Fetching latest changes from GitHub..."
git fetch origin

CURRENT_BRANCH=$(git branch --show-current)

if [ "$CURRENT_BRANCH" = "main" ] || [ "$CURRENT_BRANCH" = "master" ]; then
    # On main: just pull latest
    echo "📥 Pulling latest $CURRENT_BRANCH..."
    git pull origin "$CURRENT_BRANCH"
else
    # On feature branch: pull branch, then merge main into feature branch to stay current
    echo "🌿 On feature branch: $CURRENT_BRANCH"
    
    # Pull any updates to this branch (e.g., from another machine)
    git pull origin "$CURRENT_BRANCH" 2>/dev/null || echo "   (Branch not yet on remote, skipping pull)"
    
    # Merge main into feature branch to incorporate latest changes
    echo "🔀 Merging origin/main into your branch to stay up-to-date..."
    git merge origin/main -m "Merge main into $CURRENT_BRANCH" || {
        echo "⚠️  Merge conflicts detected. Resolve them, then run: git add . && git commit"
        exit 1
    }
fi

# 3. Restore stashed changes if they existed
if [ "$STASHED" = true ]; then
    echo "🔓 Popping your local changes back out..."
    # Allowing pop to fail gracefully in case of minor conflicts during pop
    git stash pop || echo "⚠️  Note: Conflicts occurred while restoring your local changes. Please resolve them."
fi

# 4. Sync Dependencies
# (Uncomment the block that matches your stack)
echo "📦 Checking and updating dependencies..."

## For Node.js / React / Next.js projects:
# if [ -f "package.json" ]; then
#     npm install
# fi

## For Python projects:
# if [ -f "requirements.txt" ]; then
#     pip install -r requirements.txt
# fi

## For Docker-based projects:
# if [ -f "docker-compose.yml" ]; then
#     docker-compose pull
# fi

echo "========================================="
echo "✅ Environment synced successfully!"
echo "🚀 Launching development environment..."
echo "========================================="

# 5. Start the local server
# (Modify this command to match how you boot your app)
# npm run dev

# For python/flask: python app.py
# For docker: docker-compose up