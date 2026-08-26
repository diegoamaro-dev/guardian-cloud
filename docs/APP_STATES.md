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

> **Dirección aprobada · NO implementada — fase de captura.** Bajo el contrato de
> Continuous Protection, `recording` **sigue siendo un único estado** —la §2 de
> este documento prohíbe duplicarlos— y la fase de captura pasa a ser un
> **atributo visible** suyo, nunca un estado nuevo:
>
> * `VIDEO_AUDIO` — app visible
> * `AUDIO_ONLY` — app en segundo plano o pantalla bloqueada
>
> La transición entre fases es automática y **no requiere ninguna decisión del
> usuario**. Mientras dura, el estado sigue siendo `recording`: la protección no
> se interrumpe. Hoy el sistema no tiene fases; al perder visibilidad durante
> vídeo, la grabación termina. Decide
> [`decisions/ADR-CONTINUOUS-PROTECTION.md`](./decisions/ADR-CONTINUOUS-PROTECTION.md).

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
