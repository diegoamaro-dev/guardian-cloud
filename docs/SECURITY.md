# Guardian Cloud — Security Guidelines

## 1. Objetivo

Definir los principios de seguridad del sistema Guardian Cloud.

Este documento NO busca crear un sistema impenetrable, sino:

- reducir riesgos reales
- proteger datos del usuario
- evitar fallos críticos
- mantener simplicidad en el MVP

---

## 2. Principio clave

> La seguridad no sirve de nada si el sistema falla antes de subir la evidencia.

Prioridad:

1. subir datos
2. mantener integridad
3. proteger acceso

---

## 3. Modelo de amenazas (simplificado)

El sistema debe proteger contra:

- pérdida del dispositivo
- acceso casual a datos locales
- fallos de red
- duplicación o corrupción de chunks
- acceso no autorizado al backend

No protege completamente contra:

- malware en el dispositivo
- atacantes con acceso total al sistema
- cuentas comprometidas (Drive, email)
- ataques físicos avanzados

---

## 4. Seguridad en cliente (app móvil)

### Obligatorio en MVP

- cifrado local antes de subida
- uso de almacenamiento interno seguro
- no exponer rutas de archivos
- no logs con datos sensibles
- control de permisos (cámara, micro)

### Recomendado

- borrar chunks locales tras subida confirmada
- proteger acceso a configuración sensible
- evitar almacenar tokens en texto plano

---

## 5. Seguridad en transmisión

- usar HTTPS siempre
- validar respuestas del servidor
- reintentos controlados
- evitar enviar datos sin cifrar

---

## 6. Seguridad en backend

### Reglas críticas

- validar todos los inputs
- limitar tamaño de uploads
- usar autenticación en endpoints
- no ejecutar código del usuario
- logs mínimos

### Endpoints sensibles

- /sessions
- /chunks
- /alerts

Deben:
- validar usuario
- validar estructura
- rechazar datos inválidos

---

## 7. Gestión de chunks

- cada chunk debe tener:
  - índice
  - hash
  - tamaño

- permitir reintentos sin duplicar
- tolerar desorden en llegada
- validar integridad básica

---

## 8. Autenticación

MVP:

- auth básica (Supabase)
- tokens seguros
- expiración de sesión

Evitar:

- sesiones permanentes
- credenciales en texto plano

---

## 9. Almacenamiento

Regla clave:

> Guardian Cloud NO almacena el vídeo final como servicio central

Datos en backend:
- metadatos
- estado
- sesiones

Datos en destino:
- vídeo real (Drive / NAS)

---

## 10. Logs

- registrar solo lo necesario
- evitar datos sensibles
- usar logs para debugging, no para almacenar información

---

## 11. Modo Kids

- validar relación padre-hijo
- no permitir acceso cruzado
- alertas controladas
- evitar exposición innecesaria de datos

---

## 12. Seguridad vs complejidad

Regla:

> Si una medida de seguridad rompe la fiabilidad del sistema, se rechaza en MVP

---

## 13. Errores críticos a evitar

- confiar en cliente sin validar
- almacenar datos sensibles sin cifrar
- no manejar reintentos
- perder chunks por fallos simples
- permitir endpoints abiertos sin auth

---

## 14. Futuro (NO MVP)

- cifrado extremo a extremo completo
- firma digital de evidencia
- cadena de custodia
- verificación legal avanzada

---

## 15. Regla final

> Un sistema que pierde datos es peor que uno menos seguro pero fiable.

La seguridad debe acompañar a la resiliencia, no sustituirla.