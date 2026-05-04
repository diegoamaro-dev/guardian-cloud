# Guardian Cloud — Feature Evaluation Template

## 🎯 Objetivo

Evaluar cualquier nueva funcionalidad antes de implementarla.

Evitar:
- pérdida de foco
- sobreingeniería
- features innecesarias

---

## 🧠 1. Descripción

¿En una frase, qué hace esta feature?

---

## 🎯 2. Problema real

¿Qué problema concreto resuelve?

¿Es un problema observado en uso real o una suposición?

- [ ] problema real validado
- [ ] hipótesis (no validada)

---

## 🧨 3. Impacto en el core

¿Mejora alguna de estas?

- [ ] supervivencia de la evidencia
- [ ] claridad bajo estrés
- [ ] confianza del usuario

Si no marca ninguna:

→ RECHAZAR

---

## ⚠️ 4. Riesgo

¿Puede afectar a:

- [ ] subida en tiempo real
- [ ] cola persistente
- [ ] recovery automático
- [ ] export

Si marca alguna:

→ requiere validación extrema

---

## 🧱 5. Complejidad

- líneas de código estimadas:
- nuevos módulos:
- nuevas dependencias:

Evaluación:

- [ ] simple
- [ ] media
- [ ] compleja

Si es compleja sin impacto alto:

→ RECHAZAR

---

## 🧠 6. UX bajo estrés

¿Añade:

- pasos?
- decisiones?
- confusión?

- [ ] no afecta UX
- [ ] añade fricción

Si añade fricción:

→ RECHAZAR

---

## 🧪 7. Validación

¿Cómo se prueba en condiciones reales?

- mala red
- cierre forzado
- background
- reinicio

Describir test:

---

## 🧨 8. Fase del proyecto

¿Encaja en la fase actual?

- [ ] MVP
- [ ] validación
- [ ] escalado
- [ ] futuro

Si es “futuro”:

→ NO implementar ahora

---

## 💰 9. Relación con monetización

¿Aporta valor premium real?

- [ ] sí
- [ ] no
- [ ] irrelevante ahora

---

## 🧨 10. Decisión final

- [ ] IMPLEMENTAR
- [ ] POSPONER
- [ ] RECHAZAR

Justificación:

---

## 🧨 Regla final

> Si no mejora supervivencia, claridad o confianza → no existe