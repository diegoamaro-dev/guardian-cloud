# Guardian Cloud — Kids Mode

## Estado

Kids NO forma parte del MVP actual.

Solo se implementará cuando el core esté validado con usuarios reales:
- grabación
- subida en chunks
- recovery
- export
- uso bajo estrés

## Objetivo

Permitir que un menor active Guardian Cloud desde su dispositivo y que la evidencia se envíe automáticamente al almacenamiento del padre/madre/tutor.

## Principio

El niño no configura nada.

El niño solo:
1. abre la app
2. pulsa grabar
3. la evidencia se protege en el destino del adulto

## Modelo de usuario

- El padre tiene cuenta
- El padre conecta Drive/NAS
- El padre paga Protección Familiar
- El hijo se vincula mediante QR o código
- El hijo NO necesita email ni contraseña

## Flujo

1. Padre crea cuenta
2. Padre conecta destino
3. Padre genera QR/código
4. Hijo escanea QR
5. Dispositivo queda vinculado
6. Hijo pulsa GRABAR
7. Sesión se crea como propiedad del padre
8. Chunks suben al destino del padre
9. Padre recibe alerta
10. Padre puede ver/exportar evidencia

## Precio

Plan recomendado:

Protección Familiar — 2,99€/mes

Incluye:
- hasta 3 dispositivos familiares
- alertas al adulto
- historial familiar
- export desde cuenta del adulto
- subida al destino del adulto

## Arquitectura mínima

Nuevas tablas:
- family_links
- child_devices
- family_invites

Extensión de sessions:
- actor_type
- child_device_id
- owner_user_id

Regla:
owner_user_id siempre es el adulto responsable.

## Endpoints mínimos

Padre:
- POST /family/invites
- GET /family/devices
- DELETE /family/devices/:id

Hijo:
- POST /family/link

Sesiones:
- reutilizar POST /sessions
- reutilizar POST /chunks
- reutilizar POST /sessions/:id/complete

## Qué NO se toca

- GC_QUEUE
- upload worker
- chunking
- foreground service
- export
- Drive upload core

## UX Kids

La interfaz Kids debe ser más simple que la app normal.

Pantalla principal:
- botón GRABAR enorme
- estado claro
- cero configuración
- cero decisiones

Lenguaje:
- Grabando
- Subiendo
- Protegido

No mostrar:
- chunks
- hashes
- datos técnicos
- menús complejos

## Riesgos

- responsabilidad emocional alta
- falsa sensación de seguridad
- complejidad legal
- necesidad de fiabilidad extrema
- notificaciones críticas

## Condición para implementar

No implementar Kids hasta que:

- 3 usuarios reales usen la app sin explicación
- activación <2s
- recovery validado
- export usable
- UX sin dudas

## Regla final

Kids no es una feature.

Es una promesa de protección familiar.

Si el core falla, Kids no se implementa.