# Guardian Cloud — CLAUDE.md

## 1. Rol

Estás trabajando como ingeniero senior en Guardian Cloud.

Tu objetivo es implementar el sistema sin romper su comportamiento real.

---

## 2. Document structure (CRITICAL)

El proyecto se divide en 3 capas:

### /docs → PRODUCT (SOURCE OF TRUTH)

Define el sistema real:

- START_HERE.md :contentReference[oaicite:0]{index=0}  
- ARCHITECTURE.md  
- API_SPEC.md  
- MVP_SCOPE.md  
- APP_STATES.md  
- PRODUCT_PRINCIPLES.md  
- DESIGN.md  
- UI_SCREENS.md  
- TEST_SCENARIOS.md  
- IMPLEMENTATION_STATUS.md  
- RELEASE_CHECKLIST_v0.3.md  
- SECURITY.md  

Regla:
> /docs define cómo funciona el sistema

---

### /playbook → DECISION SYSTEM

Define cómo se toman decisiones:

- GUARDIAN_CLOUD_DECISION_RULES.md  
- FEATURE_EVALUATION_TEMPLATE.md  
- WEEKLY_PRODUCT_REVIEW.md  
- CHANGE_GUARDRAILS.md  

Regla:
> guía decisiones, NO define comportamiento

---

### /strategy → CONTEXTO (NO CRÍTICO)

- MONETIZATION.md  
- CONVERSION_FLOW.md  
- POST_MVP_ROADMAP.md  

Regla:
> no afecta decisiones del sistema actual

---

## 3. Prioridad de fuentes

En caso de conflicto:

1. /docs
2. /playbook
3. /strategy (ignorar si contradice)

---

## 4. Reglas obligatorias

### ❌ NO HACER

- No inventar funcionalidades
- No añadir features fuera del MVP validado
- No cambiar arquitectura sin justificar impacto real
- No mover lógica al UI
- No tocar cola, chunking o worker sin necesidad crítica
- No introducir complejidad innecesaria

---

### ✅ HACER

- seguir MVP_SCOPE.md
- respetar PRODUCT_PRINCIPLES.md :contentReference[oaicite:1]{index=1}  
- validar con TEST_SCENARIOS.md :contentReference[oaicite:2]{index=2}  
- priorizar funcionamiento real sobre diseño

---

## 5. Prioridad del sistema

Orden obligatorio:

1. subida de chunks
2. resiliencia
3. recovery
4. integridad
5. UX

> Subir evidencia > grabar perfecto

---

## 6. Invariantes (NO ROMPER)

- subida durante grabación
- cola persistente
- recovery automático
- evidencia fuera del dispositivo ASAP
- export usable

Si uno falla:
> el sistema está roto

---

## 7. Flujo de trabajo

Antes de código:

1. leer docs relevantes
2. explicar qué vas a hacer
3. validar que respeta invariantes

Durante:

- cambios pequeños
- sin refactors masivos

Después:

- validar con TEST_SCENARIOS
- identificar riesgos

---

## 8. Validación obligatoria

Siempre cubrir:

- mala red
- kill app
- background
- reinicio

Si no:
> no es válido

---

## 9. Seguridad

Seguir SECURITY.md :contentReference[oaicite:3]{index=3}  

Pero:

> seguridad nunca puede romper la subida

---

## 10. UX

Seguir UI_SCREENS.md :contentReference[oaicite:4]{index=4}  
y UX_RELEASE_CHECKLIST.md :contentReference[oaicite:5]{index=5}  

Regla:

> si el usuario piensa, está mal

---

## 11. Decisión de features

Usar:

- FEATURE_EVALUATION_TEMPLATE.md

Si no mejora:

- supervivencia
- claridad
- confianza

→ NO implementar

---

## 12. Fase actual

El sistema YA funciona:

- chunking
- subida
- recovery
- background
- export

No es prototipo.

---

## 13. Prioridad actual

1. UX bajo estrés
2. activación inmediata
3. claridad de estado
4. export usable

---

## 14. Regla final

El sistema es incorrecto si:

- pierde datos
- no recupera
- no funciona bajo estrés

Aunque el código sea correcto

## 🚨 PRE-TASK REQUIREMENT (MANDATORY)

Before writing ANY code, you MUST complete:

CLAUDE_PRETASK_CHECK.md

You must:

1. Fill all sections
2. Identify impacted files
3. Evaluate invariants
4. Define validation

If this is skipped:
→ the task is invalid

DO NOT write code until this is done.