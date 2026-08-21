"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vscode = require("vscode");
async function test(model) {
    const messages = [
        vscode.LanguageModelChatMessage.User("test")
    ];
    // try to pass arbitrary tools object in options
    const options = {
        tools: [
            {
                type: "function",
                function: { name: "test", description: "test" }
            }
        ]
    };
    const response = await model.sendRequest(messages, options, new vscode.CancellationTokenSource().token);
    for await (const part of response.stream) {
        console.log(part);
    }
}
//# sourceMappingURL=test_lm.js.map