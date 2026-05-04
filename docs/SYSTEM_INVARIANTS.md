# Guardian Cloud — System Invariants

## 🎯 Objetivo

Definir las reglas que siempre deben cumplirse.

Si una de estas reglas se rompe:

> el sistema está roto

---

## 1. Subida durante grabación

* los chunks deben empezar a subirse mientras se graba
* no solo al final

---

## 2. Persistencia de la cola

* la cola debe sobrevivir:

  * cierre de app
  * reinicio
  * fallo

---

## 3. Recovery automático

* el sistema debe reanudar sin intervención del usuario

---

## 4. Independencia del dispositivo

* la evidencia debe existir fuera del dispositivo lo antes posible

---

## 5. Export funcional

* el usuario debe poder recuperar la evidencia fuera de la app

---

## 6. UI sin decisiones críticas

* el usuario no debe configurar antes de grabar

---

## 7. Estados consistentes

* idle, recording, uploading, protected, error
* no duplicados

---

## 8. Tolerancia a fallo

* la pérdida de chunks NO debe romper todo

---

## 9. Control del usuario

* los datos no dependen del backend central

---

## 🧨 Regla final

> Si alguna de estas invariantes falla, el producto deja de cumplir su propósito
