# Guardian Cloud — Metrics

## 🎯 Objetivo

Medir si el producto funciona en condiciones reales.

---

## 🧨 Principio

> No medir por medir. Solo métricas accionables.

---

# 🔴 1. ACTIVACIÓN

## Métrica

* tiempo desde abrir app → iniciar grabación

## Objetivo

* < 2 segundos

## Señal de problema

* > 3 segundos

## Interpretación

Si tarda:

> la UI falla

---

# 🔴 2. USO REAL

## Métrica

* número de sesiones creadas por usuario

## Objetivo

* > 2 sesiones por usuario

## Señal de problema

* 1 sesión y abandono

## Interpretación

> no ven valor o no confían

---

# 🔴 3. COMPLETADO DE SESIÓN

## Métrica

* % de sesiones completadas

## Objetivo

* > 80%

## Señal de problema

* < 60%

## Interpretación

> fallos en subida o UX

---

# 🔴 4. SUPERVIVENCIA

## Métrica

* sesiones donde al menos 1 chunk fue subido

## Objetivo

* > 95%

## Señal de problema

* < 90%

## Interpretación

> el core está fallando

---

# 🔴 5. RECOVERY

## Métrica

* sesiones recuperadas tras kill/reinicio

## Objetivo

* > 90%

## Señal de problema

* recovery manual necesario

## Interpretación

> el sistema no es resiliente

---

# 🟡 6. EXPORT

## Métrica

* % de sesiones exportadas correctamente

## Objetivo

* > 85%

## Señal de problema

* archivos no usables

## Interpretación

> pérdida de valor del producto

---

# 🟡 7. CONFIANZA (CUALITATIVA)

## Pregunta

> “¿te fiarías de esto en una situación real?”

## Objetivo

* respuesta positiva clara

## Señal de problema

* dudas o matices

---

# 🟡 8. FRICCIÓN

## Métrica

* dudas durante uso

Ejemplos:

* “¿está grabando?”
* “¿se ha guardado?”

## Objetivo

* 0 dudas

---

# 🔵 9. MONETIZACIÓN (FASE 2)

## Métrica

* % usuarios que abren paywall
* % usuarios que convierten

## Objetivo inicial

* conversión 1–5%

---

# 🧨 LO QUE NO MEDIR

* tiempo en pantalla
* clicks inútiles
* métricas vanity

---

# 🧨 REGLA FINAL

> Si una métrica baja, hay que cambiar el producto, no justificarla
