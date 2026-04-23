# Guardian Cloud — Play Store Release Plan (v1)

## 1. Objetivo

Lanzar una versión mínima funcional en Play Store que:

- funcione de verdad
- cumpla políticas
- sea entendible
- no rompa nada crítico

---

## 2. Qué incluye v1

- Grabación manual (botón)
- División en chunks
- Subida automática
- Cola persistente (SQLite)
- Reintentos automáticos
- Integración con Google Drive
- Autenticación básica
- Estado de subida visible

---

## 3. Qué NO incluye v1

- ❌ Guardian Cloud Kids completo
- ❌ múltiples destinos
- ❌ NAS
- ❌ sistema de pagos
- ❌ alertas avanzadas
- ❌ UI compleja
- ❌ IA
- ❌ modo offline avanzado

---

## 4. Permisos necesarios

- Cámara
- Micrófono
- Internet
- Almacenamiento (si aplica)
- Foreground service (si se usa)

---

## 5. Requisitos técnicos

- La grabación debe iniciarse por acción del usuario
- No grabar en background sin interacción clara
- Mostrar indicador visible de grabación
- Manejar correctamente permisos runtime

---

## 6. Data Safety (Play Console)

Declarar:

- Qué datos se usan
- Qué datos se almacenan
- Qué datos se comparten
- Uso de Drive del usuario
- No almacenamiento de vídeo en servidor propio

---

## 7. Testing obligatorio

Antes de publicar:

- 12 testers mínimo
- 14 días de prueba interna
- Test en diferentes redes
- Test con app cerrada
- Test con pérdida de conexión

---

## 8. UX mínima

- 1 pantalla principal
- 1 botón grande (grabar/parar)
- indicador de subida
- estado simple

---

## 9. Mensaje en Play Store

NO usar:

- “seguridad total”
- “garantía legal”
- “protección absoluta”

Usar:

- “preservar evidencia”
- “envío rápido”
- “control del usuario”

---

## 10. Objetivo de v1

> Validar que el sistema funciona en condiciones reales

NO escalar  
NO monetizar aún  
NO complicar