# Guardian Cloud — Decision Rules

## 🎯 Objetivo

Definir cómo se toman decisiones en el proyecto para evitar:

- desviaciones
- sobreingeniería
- pérdida de foco
- rotura del sistema

---

## 🧨 Regla 1 — Principio absoluto

> Subir evidencia > grabación perfecta

Si una decisión compromete la subida durante grabación:

→ se rechaza

---

## 🧨 Regla 2 — Invariantes

Antes de aceptar cualquier cambio:

- [ ] ¿mantiene subida en tiempo real?
- [ ] ¿mantiene cola persistente?
- [ ] ¿mantiene recovery automático?
- [ ] ¿mantiene evidencia fuera del dispositivo ASAP?
- [ ] ¿mantiene export usable?

Si alguna respuesta es NO:

→ RECHAZAR

---

## 🧨 Regla 3 — Test de valor

Toda nueva idea debe responder:

- ¿Mejora supervivencia real?
- ¿Mejora claridad bajo estrés?
- ¿Mejora confianza del usuario?

Si NO cumple al menos una:

→ NO implementar

---

## 🧨 Regla 4 — Test de complejidad

Antes de implementar:

- ¿puedo hacerlo más simple?
- ¿añade nuevas dependencias?
- ¿rompe algo que ya funciona?

Si añade complejidad sin impacto claro:

→ RECHAZAR

---

## 🧨 Regla 5 — UX bajo estrés

El usuario:

- no piensa
- no analiza
- actúa

Reglas:

- no añadir pasos antes de grabar
- no añadir decisiones innecesarias
- no mostrar datos técnicos

Si una decisión introduce fricción:

→ RECHAZAR

---

## 🧨 Regla 6 — Validación obligatoria

Nada se considera válido si no funciona en:

- mala red
- cierre forzado
- background
- reinicio

Si no pasa estas condiciones:

→ NO avanzar

---

## 🧨 Regla 7 — No romper lo que funciona

> Lo que ya funciona es más valioso que lo nuevo

Antes de cambiar algo:

- ¿esto ya funciona en condiciones reales?
- ¿el cambio introduce riesgo?

Si introduce riesgo sin beneficio claro:

→ NO tocar

---

## 🧨 Regla 8 — Orden de prioridades

Siempre trabajar en este orden:

1. supervivencia
2. claridad
3. confianza
4. rendimiento
5. features

Nunca al revés.

---

## 🧨 Regla 9 — Anti-ideas

Evitar automáticamente:

- IA sin validación real
- blockchain / “evidencia inmutable”
- múltiples destinos prematuros
- UI compleja
- métricas innecesarias
- optimización prematura

---

## 🧨 Regla 10 — Fases

No saltar fases:

- validar MVP
- validar uso real
- mejorar UX
- luego escalar

Nunca:

→ construir futuro sin validar presente

---

## 🧨 Regla 11 — Decisión final

Si hay duda:

→ elegir la opción más simple que mantenga invariantes

---

## 🧨 Regla 12 — Regla final

> Un sistema que pierde evidencia no sirve

> Un sistema simple que funciona siempre gana a uno complejo que falla