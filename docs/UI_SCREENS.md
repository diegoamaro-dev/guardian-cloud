# Guardian Cloud — UI SCREENS

## 1. PRINCIPIO

Cada pantalla debe:

- ser entendible en <2 segundos
- tener una única acción principal
- evitar distracciones
- funcionar bajo estrés

---

## 2. PANTALLA: HOME

### Objetivo
Permitir iniciar grabación inmediatamente.

### Elementos

- Botón principal (GRABAR)
- Selector simple:
  - audio
  - vídeo
- Indicador de estado:
  - listo
  - grabando
  - subiendo
- Acceso a:
  - configuración (icono)
  - historial (icono)

### Notas

- El botón debe dominar la pantalla
- Nada debe competir con él

---

## 3. PANTALLA: GRABACIÓN ACTIVA

### Objetivo
Mostrar claramente que se está grabando y subiendo.

### Elementos

- Indicador de grabación (visual claro)
- Tiempo transcurrido
- Estado de subida:
  - chunks enviados
  - estado conexión
- Botón STOP

### Notas

- Debe ser ultra clara
- Cero distracciones
- El usuario no debe dudar nunca

---

## 4. PANTALLA: ESTADO / SUBIDA

### Objetivo
Mostrar progreso de envío

### Elementos

- lista de chunks
- estado:
  - enviado
  - pendiente
  - error
- indicador de conexión

### Notas

- Puede ser secundaria
- no es crítica en MVP

---

## 5. PANTALLA: HISTORIAL

### Objetivo
Ver sesiones pasadas

### Elementos

- lista cronológica
- fecha
- tipo (audio / vídeo)
- estado:
  - completo
  - parcial
- acceso a archivo (Drive/NAS)

### Notas

- simple
- escaneable rápido

---

## 6. PANTALLA: CONFIGURACIÓN

### Objetivo
Configurar sistema

### Elementos

- cuenta
- destino almacenamiento:
  - Google Drive
  - NAS (futuro)
- privacidad
- cerrar sesión

### Notas

- técnica pero simple
- sin sobrecargar

---

## 7. PANTALLA: CONEXIÓN DRIVE

### Objetivo
Conectar Google Drive

### Elementos

- botón conectar
- estado conexión
- permisos explicados brevemente

---

## 8. PANTALLA: MODO KIDS

### Objetivo
Versión simplificada

### Elementos

- botón grabar grande
- sin configuración compleja
- feedback claro

### Notas

- más simple que home
- misma estética
- cero distracciones

---

## 9. ALERTA AL PADRE

### Objetivo
Notificar activación

### Contenido

- “Se ha activado Guardian Cloud Kids”
- hora
- estado subida

### Notas

- no alarmista
- claro

---

## 10. FLUJO PRINCIPAL

HOME
→ GRABAR
→ GRABACIÓN ACTIVA
→ SUBIDA
→ FIN

---

## 11. REGLAS

- no añadir pantallas extra
- no añadir pasos innecesarios
- no añadir menús complejos
- no añadir funcionalidades fuera del spec

---

## 12. PRIORIDAD

1. grabar
2. subir
3. sobrevivir

Todo lo demás es secundario

## 2.1 Botón de pánico (crítico)

El sistema debe permitir activación inmediata:

* acceso desde:

  * pantalla principal
  * widget (futuro)
  * shortcut Android

Comportamiento:

* 1 toque → grabación inmediata
* sin confirmación
* feedback instantáneo (vibración + estado)

---

## Regla

> El usuario no debe pensar antes de grabar

## 13. Reglas críticas de UX (bajo estrés)

### Home

* el botón principal debe dominar la pantalla
* no mostrar opciones que ralenticen la acción
* el usuario no debe tomar decisiones antes de grabar

---

### Grabación activa

* el usuario debe saber siempre:

  * que está grabando
  * que está protegido

* usar lenguaje humano:

  * "Protegido"
  * "Subiendo"

* evitar términos técnicos:

  * chunks
  * sync
  * procesos internos

---

### Historial

* mostrar solo estados comprensibles:

  * protegido
  * parcial
  * error

* NO mostrar:

  * número de chunks
  * datos técnicos

---

### Regla global

> Si el usuario tiene que pensar, la UI es incorrecta
