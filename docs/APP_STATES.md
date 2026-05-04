# Guardian Cloud — App States

## 🎯 Objetivo

Definir los estados reales del sistema visibles para el usuario.

---

## 🧠 Estados principales

### 🟢 idle

* app lista
* no hay grabación activa
* no hay subida en curso

---

### 🔴 recording

* grabación activa
* generación de chunks

---

### 🟡 uploading

* chunks pendientes o en envío

---

### 🟢 protected

* sesión completa
* todos los chunks subidos

---

### 🔴 error

* fallo en subida o sesión

---

## 2. Reglas

* los estados deben ser claros
* no se deben duplicar estados
* no añadir estados innecesarios

---

## 3. UI

Cada estado debe ser:

* visible
* entendible en <2 segundos
* sin ambigüedad

---

## 4. Regla final

> El usuario debe saber siempre qué está pasando
