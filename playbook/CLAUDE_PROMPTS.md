# Guardian Cloud — CLAUDE_PROMPTS.md

## 🎯 Objetivo

Definir prompts estándar para trabajar con Claude sin romper el sistema.

Estos prompts NO son opcionales.

Se usan siempre para:

* implementar
* debuggear
* validar cambios

---

## 🧨 Regla base

> No improvisar prompts.

Siempre usar una de estas plantillas.

---

# 🧱 1. IMPLEMENTACIÓN

Usar cuando quieras añadir o modificar algo.

```
You are working on Guardian Cloud.

IMPORTANT CONTEXT:
The core system is already working and validated:
- chunking
- persistent queue (AsyncStorage)
- upload worker
- recovery after app kill
- background upload
- export

DO NOT break existing architecture.

---

RULES:

- DO NOT modify GC_QUEUE logic
- DO NOT modify upload worker behavior
- DO NOT change chunking strategy
- DO NOT introduce new flows
- DO NOT refactor unrelated code

---

TASK:

<describe aquí lo que quieres hacer>

---

CONSTRAINTS:

- Must reuse existing flow
- Must be minimal
- Must not affect resilience
- Must not block upload

---

PROCESS:

1. Explain what you will do
2. Identify risks
3. Implement only the minimal change
4. Show code
5. Explain why it is safe

If you are unsure:
ASK instead of inventing.
```

---

# 🧱 2. DEBUG

Usar cuando algo no funciona.

```
You are debugging Guardian Cloud.

CONTEXT:
This system must survive:
- bad network
- app kill
- background execution

---

RULES:

- Do not rewrite the system
- Do not propose refactors
- Focus only on the bug

---

TASK:

<describe el error exacto + logs>

---

PROCESS:

1. Identify where the failure happens:
   - before enqueue
   - in queue
   - in upload worker
   - in backend

2. Propose minimal fix

3. Add logs if needed

4. Do not change working parts

---

IMPORTANT:

If your fix risks breaking:
- recovery
- upload
- queue

You must warn it explicitly.
```

---

# 🧱 3. VALIDACIÓN

Usar SIEMPRE antes de aceptar cambios.

```
Review this change for Guardian Cloud.

CONTEXT:
This system prioritizes:
upload > recording > everything

---

CHECK:

1. Does this affect:
   - GC_QUEUE?
   - upload worker?
   - recovery?

2. Does this introduce:
   - race conditions?
   - new states?
   - hidden complexity?

3. Does this break:
   - background behavior?
   - retry logic?

---

OUTPUT:

- SAFE ✅
- RISK ⚠️
- REJECT ❌

Explain clearly why.
```

---

# 🧠 Flujo de uso obligatorio

Siempre seguir este orden:

1. IMPLEMENTACIÓN
2. DEBUG (si algo falla)
3. VALIDACIÓN (antes de aceptar)

---

# 🚨 Errores prohibidos

* ❌ "hazme esto rápido"
* ❌ "mejora esto"
* ❌ "refactoriza esto"
* ❌ prompts vagos

---

# 🎯 Objetivo final

Evitar:

* romper GC_QUEUE
* romper upload worker
* romper recovery

---

# 🧨 Regla final

> No romper lo que ya funciona es más importante que añadir cosas nuevas
