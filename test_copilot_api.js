const vscode = require('vscode');

async function test() {
    const ext = vscode.extensions.getExtension('github.copilot');
    if (ext) {
        if (!ext.isActive) await ext.activate();
        console.log(Object.keys(ext.exports));
    }
}
