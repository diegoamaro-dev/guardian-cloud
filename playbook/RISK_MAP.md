# Guardian Cloud — Risk Map

## 🎯 Objetivo

Identificar los riesgos reales del sistema y cómo mitigarlos.

---

## 🔴 1. FALLO DE SUBIDA (CRÍTICO)

### Riesgo

* chunks no se suben durante grabación

### Impacto

* pérdida total de evidencia

### Causa

* worker detenido
* mala red sin retry correcto
* fallo en background

### Mitigación

* retry con backoff
* foreground service activo
* tests en mala red

---

## 🔴 2. COLA CORRUPTA

### Riesgo

* estado inconsistente en AsyncStorage

### Impacto

* chunks perdidos o no procesados

### Causa

* escritura concurrente
* crash en escritura

### Mitigación

* escritura serializada
* validación en recovery
* normalización al arrancar

---

## 🔴 3. RECOVERY FALLA

### Riesgo

* la app no reanuda subida tras reinicio

### Impacto

* evidencia queda atrapada en dispositivo

### Causa

* lógica de boot incompleta
* estados mal reseteados

### Mitigación

* tests de kill + reboot
* logs de recovery obligatorios

---

## 🔴 4. USUARIO NO ENTIENDE LA APP

### Riesgo

* no pulsa a tiempo
* no confía
* no sabe usar

### Impacto

* abandono
* fallo en situaciones reales

### Causa

* UX compleja
* demasiadas opciones
* mensajes ambiguos

### Mitigación

* botón dominante
* lenguaje simple
* test con usuarios reales

---

## 🔴 5. EXPORT INÚTIL

### Riesgo

* el archivo generado no sirve

### Impacto

* pérdida de valor del producto

### Causa

* chunks corruptos
* formato incompleto
* fallo en reconstrucción

### Mitigación

* validación de hash
* export parcial claro
* mejora futura streaming

---

## 🔴 6. DEPENDENCIA DE DRIVE

### Riesgo

* Drive falla o cambia API

### Impacto

* subida bloqueada

### Causa

* dependencia única

### Mitigación

* diseño multi-destino (futuro)
* fallback local
* NAS planificado

---

## 🟡 7. PERMISOS ANDROID

### Riesgo

* usuario deniega permisos

### Impacto

* app no funciona

### Mitigación

* mensajes claros
* fallback controlado

---

## 🟡 8. FOREGROUND SERVICE

### Riesgo

* no se mantiene en background

### Impacto

* subida se corta

### Mitigación

* notificación persistente
* control por estado real

---

## 🟡 9. MONETIZACIÓN MAL IMPLEMENTADA

### Riesgo

* usuario se siente presionado

### Impacto

* abandono

### Mitigación

* paywall contextual
* no bloquear básico

---

## 🟡 10. CRECIMIENTO SIN CONTROL

### Riesgo

* demasiadas features

### Impacto

* sistema complejo
* bugs

### Mitigación

* respetar MVP_SCOPE
* validar antes de avanzar

---

## 🧨 PRIORIDAD

Orden de importancia:

1. Subida
2. Recovery
3. UX bajo estrés
4. Export
5. Escalado

---

## 🧨 Regla final

> Si el sistema falla en condiciones reales, no importa que funcione en demo
