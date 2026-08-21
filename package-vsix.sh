#!/usr/bin/env bash
# Offline VSIX packager for Copilot Pulse (no vsce required — extension has no runtime deps).
set -euo pipefail
# Resolve the project root from this script's own location so the packager
# keeps working no matter where the repo is checked out.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

# Always package a fresh compile so the VSIX can never ship stale JS.
echo "Compiling TypeScript..."
npx tsc -p ./tsconfig.offline.json

STAGE="$(mktemp -d)"
mkdir -p "$STAGE/extension"

# Generate the vsixmanifest from package.json.
#
# The previously reused manifest was missing
#   <Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.95.0" />
# which vsce always emits. Without it VS Code has no recorded engine
# constraint for the package, so an incompatible host would install the
# extension and then fail at runtime instead of refusing up front.
ENGINE="$(node -p "require('./package.json').engines.vscode")"
DISPLAY_NAME="$(node -p "require('./package.json').displayName")"
DESCRIPTION="$(node -p "require('./package.json').description.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')")"
VERSION="$(node -p "require('./package.json').version")"
PUBLISHER="$(node -p "require('./package.json').publisher")"
NAME="$(node -p "require('./package.json').name")"

cat > "$STAGE/extension.vsixmanifest" <<XML
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Id="${NAME}" Version="${VERSION}" Publisher="${PUBLISHER}" />
    <DisplayName>${DISPLAY_NAME}</DisplayName>
    <Description xml:space="preserve">${DESCRIPTION}</Description>
    <Tags>AI,copilot,github copilot,model router,llm,agent,cost savings</Tags>
    <Categories>AI,Other</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${ENGINE}" />
      <Property Id="Microsoft.VisualStudio.Services.Links.Source" Value="https://github.com/your-org/copilot-pulse-vscode" />
      <Property Id="Microsoft.VisualStudio.Services.Links.GitHub" Value="https://github.com/your-org/copilot-pulse-vscode" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Changelog" Path="extension/CHANGELOG.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/icon.png" Addressable="true" />
  </Assets>
</PackageManifest>
XML

cat > "$STAGE/[Content_Types].xml" <<'XML'
<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json"/>
  <Default Extension="js" ContentType="application/javascript"/>
  <Default Extension="map" ContentType="application/json"/>
  <Default Extension="md" ContentType="text/markdown"/>
  <Default Extension="png" ContentType="image/png"/>
  <Default Extension="vsixmanifest" ContentType="text/xml"/>
</Types>
XML

cp package.json "$STAGE/extension/package.json"
cp README.md "$STAGE/extension/README.md"
cp CHANGELOG.md "$STAGE/extension/CHANGELOG.md"
cp LICENSE "$STAGE/extension/LICENSE"
cp icon.png "$STAGE/extension/icon.png"
cp -R out "$STAGE/extension/out"

OUT="/tmp/copilot-pulse.vsix"
rm -f "$OUT"
( cd "$STAGE" && zip -r -X "$OUT" '[Content_Types].xml' extension.vsixmanifest extension >/dev/null )
mv "$OUT" "$ROOT/copilot-pulse-vscode-1.0.0.vsix"
rm -rf "$STAGE"

echo "Packaged: $ROOT/copilot-pulse-vscode-1.0.0.vsix"

