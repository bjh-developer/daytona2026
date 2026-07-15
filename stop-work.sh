#!/bin/bash

# Exit immediately if a command exits with a non-zero status
set -e

echo "========================================="
echo "🛑 Winding down your work session..."
echo "========================================="

# 1. Kill any lingering background dev servers (Port cleanup)
# Especially helpful if tools like Next.js or Flask don't exit cleanly
# Uncomment below when you have dev servers running
echo "🔌 Cleaning up local development processes..."
# pkill -f "node" || true    # For Linux/Mac
# pkill -f "python" || true  # For Linux/Mac
# taskkill //F //IM node.exe 2>/dev/null || true   # For Windows
# taskkill //F //IM python.exe 2>/dev/null || true # For Windows

# 2. Code Linting / Formatting Check (Optional but life-saving)
# Running this before pushing prevents breaking the build for everyone else
if [ -f "package.json" ]; then
    if grep -q "\"lint\"" package.json; then
        echo "🧹 Running code linter/formatter..."
        npm run lint -- --fix || echo "⚠️ Linter found errors. Please fix them before final deployment!"
    fi
fi

# 3. Handle Git Branching and Pushing
echo "🌿 Preparing to save your progress..."

# Get current branch name
CURRENT_BRANCH=$(git branch --show-current)

# Prevent accidental pushes directly to main/master during a frenzy
if [ "$CURRENT_BRANCH" = "main" ] || [ "$CURRENT_BRANCH" = "master" ]; then
    echo "⚠️  You are currently on the '$CURRENT_BRANCH' branch."
    read -p "It's safer to push to a feature branch. Enter new branch name (or press Enter to stay on $CURRENT_BRANCH): " NEW_BRANCH
    
    if [ -n "$NEW_BRANCH" ]; then
        git checkout -b "$NEW_BRANCH"
        CURRENT_BRANCH=$NEW_BRANCH
    fi
fi

# 4. Stage and Commit changes
if [ -n "$(git status --porcelain)" ]; then
    echo "📝 Found changes to save."
    git add .
    
    # Prompt user for a quick commit message
    echo "Enter a brief commit message describing what you did:"
    read -r COMMIT_MSG
    
    if [ -z "$COMMIT_MSG" ]; then
        COMMIT_MSG="work in progress: checkpoint via stop-work script"
    fi
    
    git commit -m "$COMMIT_MSG"
else
    echo "✨ No new changes detected since your last commit."
fi

# 5. Push to GitHub
echo "🚀 Pushing code to origin/$CURRENT_BRANCH..."
git push origin "$CURRENT_BRANCH"

echo "========================================="
echo "🎉 Work saved and pushed successfully!"
echo "📢 Tip: Drop a text in your team chat letting them know what you finished."
echo "========================================="