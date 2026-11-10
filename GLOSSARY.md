# Keybridge

Keybridge is a local bridge that lets Cursor run on the user's own model accounts and API keys.

## Language

**Run**:
Everything done to answer one user message, including all of its tool steps.
_Avoid_: Turn, request

### Combos

**Combo**:
One model name in Cursor's model picker that stands for several models.
_Avoid_: Router, group, pool, alias

**Member**:
One model inside a combo.
_Avoid_: Target, backend, slot

**Strategy**:
A combo's rule for which member takes a run first: ordered, loop, or random.
_Avoid_: Mode, policy, routing

**Fallback**:
The move from a member that failed to another member of the same combo.
_Avoid_: Retry, failover

**Refusal**:
A model's explicit signal that it declines to answer on policy grounds. A refusal is distinct from an error.
_Avoid_: Block, censorship, content filter
