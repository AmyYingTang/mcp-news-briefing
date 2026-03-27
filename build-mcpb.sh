#!/bin/bash
# Build and package mcp-news-briefing as a .mcpb Desktop Extension
#
# Usage: ./build-mcpb.sh
# Output: mcp-news-briefing.mcpb (ready to install in Claude Desktop)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "📦 Building mcp-news-briefing Desktop Extension..."

# 1. Clean previous build
echo "  🧹 Cleaning..."
rm -rf dist/ bundle/ mcp-news-briefing.mcpb

# 2. Install all deps (need tsc to compile)
echo "  📥 Installing dependencies..."
npm install --ignore-scripts 2>/dev/null

# 3. Compile TypeScript
echo "  🔨 Compiling TypeScript..."
npx tsc

# 4. Re-install production only (strip devDependencies from bundle)
echo "  📥 Pruning to production dependencies..."
rm -rf node_modules
npm install --omit=dev --ignore-scripts 2>/dev/null

# 5. Assemble bundle directory
echo "  📁 Assembling bundle..."
mkdir -p bundle/dist

# Copy compiled JS
cp dist/*.js bundle/dist/

# Copy manifest & package.json
cp manifest.json bundle/
cp package.json bundle/

# Copy node_modules (production only)
cp -r node_modules bundle/

# 6. Create .mcpb (it's just a zip)
echo "  🗜️  Packing .mcpb..."
cd bundle
# Exclude unnecessary files to reduce size
zip -r ../mcp-news-briefing.mcpb . \
  -x "*.ts" "*.map" "*.d.ts" "*.d.ts.map" \
  -x "*/test/*" "*/tests/*" "*/__tests__/*" "*/spec/*" \
  -x "*/.eslintrc" "*/.eslintrc.*" \
  -x "*/CHANGELOG*" "*/HISTORY*" "*/CHANGES*" \
  -x "*/.github/*" "*/example/*" "*/examples/*" \
  -x "*/benchmark/*" "*/benchmarks/*" "*/coverage/*" \
  -x "*/.travis.yml" "*/.editorconfig" \
  -x "*/Makefile" "*/Gruntfile*" "*/Gulpfile*" \
  -x "*/.nyc_output/*" "*/.nycrc" \
  > /dev/null
cd ..

# 7. Cleanup
rm -rf bundle/

# 8. Restore dev deps for development
npm install --ignore-scripts 2>/dev/null

SIZE=$(du -h mcp-news-briefing.mcpb | cut -f1)
echo ""
echo "✅ Done! mcp-news-briefing.mcpb ($SIZE)"
echo ""
echo "To install:"
echo "  1. Open Claude Desktop"
echo "  2. Settings → Extensions → Install Extension"
echo "  3. Select mcp-news-briefing.mcpb"
