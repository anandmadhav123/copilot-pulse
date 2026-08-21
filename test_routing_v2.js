/**
 * Copilot Pulse — routing v2 & auto-escalation test suite.
 *
 * Covers the P0 feature set:
 *   1. Conversation-aware scoring (follow-ups must not collapse to Light)
 *   2. Tool-aware tiering (Agent Mode must NOT always be Heavy)
 *   3. Stuck-tool-loop detection
 *   4. Escalation ladder + budget cap
 *   5. Hard-error escalation
 *   6. Empty / malformed-response escalation
 */
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const moduleLib = require('module');
const mockVscode = {
  window: { showErrorMessage: () => {} },
  workspace: { getConfiguration: () => ({ get: () => undefined }) },
  StatusBarAlignment: { Right: 1, Left: 2 },
  authentication: { getSession: async () => ({ accessToken: 'fake' }) }
};
moduleLib._cache['vscode'] = { id: 'vscode', filename: 'vscode', loaded: true, exports: mockVscode };
const originalRequire = moduleLib.prototype.require;
moduleLib.prototype.require = function (request) {
  if (request === 'vscode') return mockVscode;
  return originalRequire.apply(this, arguments);
};

const { RouterLogic } = require('./out/proxy/RouterLogic.js');
const { ModelTiering, Band } = require('./out/proxy/ModelTiering.js');
const { conversationStore, toolArgsKey } = require('./out/routing/ConversationState.js');
const {
  evaluateTurn,
  isEscalatableError,
  isPromptSizeError,
  declaresIncapacity,
  nextBandUp,
  pickEscalationModel,
  EscalationReason,
  DEFAULT_ESCALATION_SETTINGS
} = require('./out/routing/EscalationPolicy.js');
const { extractFeatures, detectDissatisfaction, requiresTools } = require('./out/routing/PromptFeatures.js');

/** A realistic Copilot subscription model spread. */
const MODELS = ['gpt-4o-mini', 'o3-mini', 'gpt-4o', 'o1', 'claude-3.5-sonnet'];

const CFG = {
  useDynamicTiers: true,
  threshold: 6.5,
  lowThreshold: 4.0,
  availableModels: MODELS,
  routingV2: true
};

describe('Routing v2 — model strength corrections', () => {
  it('ranks gpt-4o above gpt-4 (v1 had this inverted)', () => {
    assert.ok(
      ModelTiering.strengthOf('gpt-4o') > ModelTiering.strengthOf('gpt-4'),
      'gpt-4o must outrank gpt-4'
    );
  });

  it('keeps mini/nano variants in the Light band', () => {
    assert.equal(ModelTiering.bandOf('gpt-4o-mini'), Band.LIGHT);
    assert.equal(ModelTiering.bandOf('gpt-4.1-nano'), Band.LIGHT);
  });

  it('flags Light models as unreliable for tool calling', () => {
    assert.equal(ModelTiering.supportsReliableToolCalling('gpt-4o-mini'), false);
    assert.equal(ModelTiering.supportsReliableToolCalling('gpt-4o'), true);
  });
});

describe('Routing v2 — intent priority (no more array-position bias)', () => {
  it('classifies a pure lookup as QUICK_LOOKUP, not ARCHITECTURE', () => {
    assert.equal(RouterLogic.detectTaskType('what is the command to list files?'), 'QUICK_LOOKUP');
  });

  it('still classifies real architecture work as ARCHITECTURE', () => {
    assert.equal(
      RouterLogic.detectTaskType('design a distributed system with microservices and a message queue'),
      'ARCHITECTURE'
    );
  });
});

describe('FEATURE 1 — conversation-aware scoring', () => {
  beforeEach(() => conversationStore.clear());

  it('does NOT collapse a deep session to Light on a short follow-up', () => {
    const conversationId = 'conv_test_1';

    const first = RouterLogic.routeDecision(
      'Design a distributed event-driven architecture with microservices, message queues and load balancing across regions',
      CFG,
      false,
      { conversationId, turnDepth: 1 }
    );
    assert.equal(first.band, Band.HEAVY, 'architecture prompt must start Heavy');

    // The classic regression: a 3-word follow-up.
    const followUp = RouterLogic.routeDecision('now fix it', CFG, false, {
      conversationId,
      turnDepth: 2
    });

    assert.notEqual(followUp.band, Band.LIGHT, 'follow-up must NOT fall to the Light tier');
    assert.ok(followUp.score > 4.0, `follow-up score should stay elevated, got ${followUp.score}`);
  });

  it('still lets an unrelated new conversation score low', () => {
    const fresh = RouterLogic.routeDecision('now fix it', CFG, false, {
      conversationId: 'conv_unrelated',
      turnDepth: 1
    });
    assert.equal(fresh.band, Band.LIGHT, 'a brand-new trivial prompt should be Light');
  });

  it('decays gradually — one band at a time, not off a cliff', () => {
    const conversationId = 'conv_decay';
    RouterLogic.routeDecision(
      'Design a distributed system architecture with microservices and scalable data pipelines',
      CFG,
      false,
      { conversationId }
    );
    const t2 = RouterLogic.routeDecision('thanks', CFG, false, { conversationId });
    const t3 = RouterLogic.routeDecision('thanks', CFG, false, { conversationId });
    assert.ok(t3.score <= t2.score, 'score should decay across turns');
  });
});

describe('FEATURE 2 — tool-aware tiering (no more always-Heavy agent mode)', () => {
  beforeEach(() => conversationStore.clear());

  it('routes a SIMPLE agent request to Medium, not Heavy', () => {
    const d = RouterLogic.routeDecision('rename this variable', CFG, true, {
      conversationId: 'conv_tools_simple',
      toolCount: 5
    });
    assert.notEqual(d.band, Band.HEAVY, 'simple agent turns must not be forced to Heavy');
    assert.equal(d.savings, true, 'a non-Heavy route must be recorded as savings');
  });

  it('never routes a tool request to a Light model', () => {
    const d = RouterLogic.routeDecision('hi', CFG, true, {
      conversationId: 'conv_tools_floor',
      toolCount: 3
    });
    assert.notEqual(d.band, Band.LIGHT, 'tool calling requires at least Medium');
    assert.ok(
      ModelTiering.supportsReliableToolCalling(d.model),
      `${d.model} must be tool-reliable`
    );
    assert.match(d.floorReason || '', /tool calling/i);
  });

  it('still sends genuinely complex agent work to Heavy', () => {
    const d = RouterLogic.routeDecision(
      'Refactor the distributed microservice architecture to fix the race condition and deadlock in the concurrency layer',
      CFG,
      true,
      { conversationId: 'conv_tools_hard', toolCount: 40 }
    );
    assert.equal(d.band, Band.HEAVY);
  });

  it('legacy mode (routingV2=false) reproduces the old always-Heavy behaviour', () => {
    const d = RouterLogic.routeDecision('hi', { ...CFG, routingV2: false }, true, {});
    assert.equal(d.band, Band.HEAVY, 'v1 behaviour must still be available as a fallback');
  });
});

describe('FEATURE 3 — stuck tool loop detection', () => {
  beforeEach(() => conversationStore.clear());

  it('counts consecutive identical tool calls', () => {
    const id = 'conv_stuck';
    const sig = { name: 'run_in_terminal', argsKey: toolArgsKey({ cmd: './gradlew build' }) };
    assert.equal(conversationStore.noteToolCall(id, sig), 1);
    assert.equal(conversationStore.noteToolCall(id, sig), 2);
    assert.equal(conversationStore.noteToolCall(id, sig), 3);
  });

  it('resets the streak when a different tool is used', () => {
    const id = 'conv_stuck_reset';
    const a = { name: 'run_in_terminal', argsKey: 'x' };
    const b = { name: 'read_file', argsKey: 'y' };
    conversationStore.noteToolCall(id, a);
    conversationStore.noteToolCall(id, a);
    assert.equal(conversationStore.noteToolCall(id, b), 1, 'a new tool restarts the streak');
  });

  it('escalates once the stuck threshold is reached', () => {
    const record = conversationStore.get('conv_stuck_esc');
    const decision = evaluateTurn({ maxToolRepeat: 2 }, record, Band.LIGHT);
    assert.equal(decision.shouldEscalate, true);
    assert.equal(decision.reason, EscalationReason.STUCK_TOOL_LOOP);
    assert.equal(decision.nextBand, Band.MEDIUM);
  });
});

describe('FEATURE 4 — escalation ladder & budget cap', () => {
  beforeEach(() => conversationStore.clear());

  it('walks Light → Medium → Heavy then stops', () => {
    assert.equal(nextBandUp(Band.LIGHT), Band.MEDIUM);
    assert.equal(nextBandUp(Band.MEDIUM), Band.HEAVY);
    assert.equal(nextBandUp(Band.HEAVY), null, 'nothing is stronger than Heavy');
  });

  it('refuses to escalate past the per-conversation budget', () => {
    const record = conversationStore.get('conv_budget');
    record.escalations = DEFAULT_ESCALATION_SETTINGS.maxEscalations;
    const decision = evaluateTurn({ maxToolRepeat: 5 }, record, Band.LIGHT);
    assert.equal(decision.shouldEscalate, false, 'budget cap must block runaway cost');
  });

  it('refuses to escalate when already on the strongest tier', () => {
    const record = conversationStore.get('conv_top');
    const decision = evaluateTurn({ maxToolRepeat: 5 }, record, Band.HEAVY);
    assert.equal(decision.shouldEscalate, false);
  });

  it('honours disabling escalation entirely', () => {
    const record = conversationStore.get('conv_off');
    const decision = evaluateTurn({ maxToolRepeat: 9 }, record, Band.LIGHT, {
      ...DEFAULT_ESCALATION_SETTINGS,
      enabled: false
    });
    assert.equal(decision.shouldEscalate, false);
  });

  it('honours a restricted trigger list', () => {
    const record = conversationStore.get('conv_triggers');
    const decision = evaluateTurn({ maxToolRepeat: 9 }, record, Band.LIGHT, {
      ...DEFAULT_ESCALATION_SETTINGS,
      triggers: [EscalationReason.HARD_ERROR] // stuck-loop NOT enabled
    });
    assert.equal(decision.shouldEscalate, false);
  });

  it('picks the strongest model in the escalated band', () => {
    const picked = pickEscalationModel(Band.HEAVY, MODELS);
    assert.ok(picked, 'must find a heavy model');
    assert.equal(ModelTiering.bandOf(picked), Band.HEAVY);
  });

  it('raises the conversation floor so it never drops back down', () => {
    const id = 'conv_floor';
    RouterLogic.routeDecision('hello', CFG, false, { conversationId: id });
    conversationStore.noteEscalation(id, Band.HEAVY);
    const after = RouterLogic.routeDecision('thanks', CFG, false, { conversationId: id });
    assert.equal(after.band, Band.HEAVY, 'an escalated conversation must stay escalated');
    assert.match(after.floorReason || '', /escalated/i);
  });
});

describe('FEATURE 5 — hard-error escalation', () => {
  beforeEach(() => conversationStore.clear());

  it('recognises model-capability errors as escalatable', () => {
    assert.equal(isEscalatableError(new Error('context_length_exceeded')), true);
    assert.equal(isEscalatableError(new Error('This model does not support tool calling')), true);
    assert.equal(isEscalatableError(new Error('Response blocked by content filter')), true);
    assert.equal(isEscalatableError(new Error('model not found')), true);
  });

  it('does NOT escalate on transient network errors', () => {
    assert.equal(isEscalatableError(new Error('ECONNRESET')), false);
    assert.equal(isEscalatableError(new Error('socket hang up')), false);
  });

  it('escalates a turn that failed with a capability error', () => {
    const record = conversationStore.get('conv_hard_err');
    const decision = evaluateTurn(
      { error: new Error('maximum context length exceeded') },
      record,
      Band.MEDIUM
    );
    assert.equal(decision.shouldEscalate, true);
    assert.equal(decision.reason, EscalationReason.HARD_ERROR);
    assert.equal(decision.nextBand, Band.HEAVY);
  });
});

describe('FEATURE 6 — empty, malformed & incapacity escalation', () => {
  beforeEach(() => conversationStore.clear());

  it('escalates on a completely empty response', () => {
    const record = conversationStore.get('conv_empty');
    const decision = evaluateTurn({ text: '', toolCalls: [] }, record, Band.LIGHT);
    assert.equal(decision.shouldEscalate, true);
    assert.equal(decision.reason, EscalationReason.EMPTY_RESPONSE);
  });

  it('escalates on a malformed tool call', () => {
    const record = conversationStore.get('conv_malformed');
    const decision = evaluateTurn({ malformedToolCall: true }, record, Band.MEDIUM);
    assert.equal(decision.shouldEscalate, true);
    assert.equal(decision.reason, EscalationReason.MALFORMED_TOOL_CALL);
  });

  it('escalates when the model admits it cannot do the task', () => {
    assert.equal(declaresIncapacity('I cannot help with this request'), true);
    assert.equal(declaresIncapacity("I'm not able to complete this"), true);
    assert.equal(declaresIncapacity('Here is the working solution.'), false);
  });

  it('escalates after repeated tool errors', () => {
    const record = conversationStore.get('conv_toolerrs');
    const decision = evaluateTurn({ toolErrors: 3, text: 'trying' }, record, Band.LIGHT);
    assert.equal(decision.shouldEscalate, true);
    assert.equal(decision.reason, EscalationReason.REPEATED_TOOL_ERRORS);
  });

  it('does NOT escalate a healthy turn', () => {
    const record = conversationStore.get('conv_ok');
    const decision = evaluateTurn(
      { text: 'Here is the fix, applied successfully.', toolCalls: [{ name: 'edit', argsKey: 'a' }], toolErrors: 0, maxToolRepeat: 1 },
      record,
      Band.LIGHT
    );
    assert.equal(decision.shouldEscalate, false, 'healthy turns must never escalate');
  });
});

describe('REGRESSION — prompt-tsx context overflow ("No lowest priority node found")', () => {
  beforeEach(() => conversationStore.clear());

  it('recognises the prompt-tsx pruning failure as a prompt-size error', () => {
    assert.equal(isPromptSizeError(new Error('No lowest priority node found (path: Gte)')), true);
    assert.equal(isPromptSizeError(new Error('context_length_exceeded')), true);
    assert.equal(isPromptSizeError(new Error('Failed to render prompt')), true);
  });

  it('does NOT treat ordinary failures as prompt-size errors', () => {
    assert.equal(isPromptSizeError(new Error('ECONNRESET')), false);
    assert.equal(isPromptSizeError(new Error('Tool execution failed')), false);
    assert.equal(isPromptSizeError(null), false);
  });

  it('escalates to a larger-context model on a prompt-tsx overflow', () => {
    const record = conversationStore.get('conv_prompt_tsx');
    const decision = evaluateTurn(
      { error: new Error('No lowest priority node found (path: Gte)') },
      record,
      Band.LIGHT
    );
    assert.equal(decision.shouldEscalate, true, 'overflow must trigger an escalation');
    assert.equal(decision.reason, EscalationReason.HARD_ERROR);
    assert.equal(decision.nextBand, Band.MEDIUM);
  });

  it('ROOT CAUSE: a tool-calling request must never route to a Light model', () => {
    // The reported failure routed to GPT-4o mini (Light, smallest context) for
    // a request carrying the full VS Code tool catalogue.
    const d = RouterLogic.routeDecision('imp info', CFG, true, {
      conversationId: 'conv_regression_tools',
      toolCount: 60
    });
    assert.notEqual(d.band, Band.LIGHT, 'tool requests must be floored above Light');
    // The real invariant is the *band*, not the model name: o3-mini is a
    // legitimate Medium-tier, tool-reliable model despite the "mini" suffix.
    assert.ok(
      ModelTiering.supportsReliableToolCalling(d.model),
      `${d.model} must be strong enough for tool calling`
    );
    assert.notEqual(d.model, 'gpt-4o-mini', 'must not pick the Light-tier model that caused the reported failure');
  });

  it('a low-scoring prompt WITHOUT tools may still use a Light model', () => {
    const d = RouterLogic.routeDecision('imp info', CFG, false, {
      conversationId: 'conv_regression_notools'
    });
    assert.equal(d.band, Band.LIGHT, 'savings must still apply when no tools are involved');
  });

  it('withholds tools ONLY for high-confidence informational questions', () => {
    assert.equal(requiresTools('what is a linked list?'), false);
    assert.equal(requiresTools('explain how closures work'), false);
    assert.equal(requiresTools('how does garbage collection work?'), false);
    assert.equal(requiresTools('tell me about generics'), false);
  });

  it('THE FIX: short continuations MUST keep tools ("do it for me")', () => {
    // Regression: "do it for me" matched no action verb, so tools were
    // withheld and the agent replied "I'm unable to execute commands".
    assert.equal(requiresTools('do it for me'), true);
    assert.equal(requiresTools('go ahead'), true);
    assert.equal(requiresTools('yes please'), true);
    assert.equal(requiresTools('continue'), true);
    assert.equal(requiresTools('apply the changes'), true);
    assert.equal(requiresTools('make it so'), true);
  });

  it('defaults to attaching tools for ambiguous prompts', () => {
    // Withholding tools breaks the agent; extra tokens merely cost a little.
    assert.equal(requiresTools('imp info'), true);
    assert.equal(requiresTools('the build is broken'), true);
    assert.equal(requiresTools('hmm'), true);
  });

  it('keeps tools available once a conversation has gone agentic', () => {
    // Even a pure question keeps tools if the session already used them.
    assert.equal(requiresTools('what is a linked list?', { conversationUsedTools: true }), true);
  });

  it('action prompts still request the tool catalogue', () => {
    assert.equal(requiresTools('fix the failing build'), true);
    assert.equal(requiresTools('run the gradle build'), true);
    assert.equal(requiresTools('add a test for the parser'), true);
    assert.equal(requiresTools('refactor this file'), true);
  });
});

describe('FEATURE 9 — user dissatisfaction detection', () => {
  it('detects the common "it did not work" phrasings', () => {
    assert.equal(detectDissatisfaction('still broken'), true);
    assert.equal(detectDissatisfaction("that's wrong"), true);
    assert.equal(detectDissatisfaction("didn't work"), true);
    assert.equal(detectDissatisfaction('same error'), true);
    assert.equal(detectDissatisfaction('try again please'), true);
  });

  it('does not fire on normal prompts', () => {
    assert.equal(detectDissatisfaction('add a test for the parser'), false);
    assert.equal(detectDissatisfaction('what is a closure?'), false);
  });

  it('raises the score of a dissatisfied follow-up', () => {
    const calm = RouterLogic.calculateScoreV2('add a helper function');
    const upset = RouterLogic.calculateScoreV2("that's wrong, it's still broken");
    assert.ok(upset.total > calm.total, 'dissatisfaction must raise complexity');
  });
});

describe('FEATURE 7 — richer structural & context signals', () => {
  it('detects stack traces', () => {
    const f = extractFeatures('Traceback (most recent call last)\n  File "a.py", line 3');
    assert.equal(f.hasStackTrace, true);
  });

  it('detects unified diffs', () => {
    const f = extractFeatures('diff --git a/x.ts b/x.ts\n@@ -1,3 +1,4 @@');
    assert.equal(f.hasDiff, true);
  });

  it('detects cross-file references', () => {
    const f = extractFeatures('update src/a.ts and src/b.ts together');
    assert.equal(f.hasMultiFileRefs, true);
  });

  it('counts multi-part requirements', () => {
    const f = extractFeatures('1. add tests\n2. fix the bug\n3. update docs');
    assert.ok(f.requirementCount >= 3, `expected >=3 requirements, got ${f.requirementCount}`);
  });

  it('raises the score when many files are attached', () => {
    const bare = RouterLogic.calculateScoreV2('update this code');
    const rich = RouterLogic.calculateScoreV2('update this code', {
      attachmentCount: 5,
      attachmentBytes: 90_000
    });
    assert.ok(rich.total > bare.total, 'attachments must increase complexity');
  });

  it('produces an explainable breakdown', () => {
    const b = RouterLogic.calculateScoreV2('design a scalable distributed system', { toolCount: 10 });
    assert.ok(b.signals, 'breakdown must expose per-signal contributions');
    assert.ok(typeof b.signals.intent === 'number');
    assert.ok(Array.isArray(b.notes));
    assert.ok(b.total >= 0 && b.total <= 10, 'score must stay in range');
  });
});


