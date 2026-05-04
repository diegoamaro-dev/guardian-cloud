# Guardian Cloud — Claude Pre-Task Check

## 🎯 Objetivo

Forzar a Claude a analizar antes de escribir código.

Evitar:
- cambios peligrosos
- romper invariantes
- tocar partes críticas sin control

---

## 🧨 Regla

NO escribir código hasta completar este checklist.

---

## 🧠 1. Descripción de la tarea

¿Qué vas a hacer exactamente?

---

## 📂 2. Archivos afectados

Lista exacta:

- mobile/...
- backend/...

---

## 🧨 3. Impacto en partes críticas

¿Esto afecta a:

- [ ] GC_QUEUE
- [ ] upload worker
- [ ] chunking
- [ ] recovery
- [ ] export

Si marca alguna:

→ requiere máxima precaución

---

## 🧱 4. Invariantes

¿Se mantienen?

- [ ] subida durante grabación
- [ ] cola persistente
- [ ] recovery automático
- [ ] evidencia fuera del dispositivo ASAP
- [ ] export usable

Si alguno NO:

→ RECHAZAR

---

## ⚠️ 5. Riesgos

Posibles fallos:

- pérdida de chunks
- subida incompleta
- duplicados
- desorden
- fallo en recovery

---

## 🧪 6. Validación

¿Cómo se prueba?

- mala red
- kill app
- background
- reinicio

---

## 🧠 7. Scope

¿Está dentro de MVP_SCOPE.md?

- [ ] sí
- [ ] no

Si no:

→ NO implementar

---

## 🧠 8. Complejidad

- [ ] mínima
- [ ] media
- [ ] alta

Si alta sin impacto claro:

→ RECHAZAR

---

## 🧠 9. Alternativa simple

¿Existe una forma más simple?

Describir:

---

## 🧨 10. Decisión

- [ ] proceder
- [ ] ajustar
- [ ] cancelar

---

## 🧨 Regla final

> Si hay duda, NO escribir código