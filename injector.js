(function() {
  console.log("[Copilot Pulse Injector] Loaded into VS Code UI!");

  function calculateTier(prompt) {
    const p = prompt.toLowerCase();
    if (/(architect|system design|microservice|scale|o\(n\)|algorithm)/.test(p)) return "Heavy";
    if (/(refactor|debug|fix|optimize|implement)/.test(p)) return "Medium";
    return "Light";
  }

  function getModelForTier(tier) {
    if (tier === "Heavy") return "o1";
    if (tier === "Medium") return "claude-3.5-sonnet";
    return "gpt-4o-mini";
  }

  function startInjection() {
    const observer = new MutationObserver(() => {
      // Find chat inputs
      const chatInputs = document.querySelectorAll('textarea');
      
      chatInputs.forEach(input => {
        // Only target textareas that look like the chat input
        if (input.closest('.interactive-input-part') || input.closest('.chat-input-widget') || input.className.includes('input')) {
          
          if (!input.dataset.pulseInjected) {
            input.dataset.pulseInjected = "true";
            
            input.addEventListener('input', (e) => {
              const prompt = e.target.value;
              const tier = calculateTier(prompt);
              const targetModel = getModelForTier(tier);
              
              // Give the input itself a green border so they know it worked!
              input.style.borderBottom = "2px solid #00FF00";
              
              // Find the model dropdown button
              const labels = document.querySelectorAll('.monaco-dropdown, .monaco-button, .chat-model-picker, span.label-name');
              
              labels.forEach(label => {
                const text = label.innerText.toLowerCase();
                const title = label.getAttribute('title') || "";
                
                // If the label is a dropdown or button related to models
                if (title.toLowerCase().includes("model") || text.includes("gpt-") || text.includes("claude") || text.includes("o1") || text.includes("auto")) {
                  if (label.innerText !== targetModel) {
                     label.innerText = targetModel;
                     label.style.color = "#00FF00"; 
                  }
                }
              });
            });
          }
        }
      });
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  // Start after a slight delay to let the UI load
  setTimeout(startInjection, 3000);
})();
