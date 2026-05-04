# Guardian Cloud — Anti-Patterns

## 🎯 Objetivo

Definir lo que NO se debe hacer en el sistema.

---

## 1. Romper prioridad del sistema

❌ Optimizar grabación a costa de subida
❌ retrasar subida por calidad

---

## 2. Meter lógica en UI

❌ UI que decide comportamiento
❌ lógica de negocio en pantallas

Regla:

> la UI observa, no decide

---

## 3. Introducir complejidad innecesaria

❌ nuevos estados sin necesidad
❌ flujos alternativos
❌ configuraciones extra

---

## 4. Mostrar información técnica al usuario

❌ chunks
❌ hashes
❌ procesos internos

---

## 5. Añadir pasos antes de grabar

❌ confirmaciones
❌ menús previos
❌ decisiones obligatorias

---

## 6. Romper flujo de recuperación

❌ eliminar datos antes de subir
❌ no reintentar correctamente

---

## 7. Monetización agresiva

❌ bloquear funcionalidad básica
❌ paywall en frío
❌ presión al usuario

---

## 8. Sobreingeniería de seguridad

❌ cifrado complejo que ralentiza
❌ validaciones que bloquean subida

---

## 🧨 Regla final

> Si algo hace el sistema más lento, complejo o confuso bajo estrés → es incorrecto
