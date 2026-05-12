# DEBUGGING_RULES.md

# Guardian Cloud — Debugging Rules

Este documento define reglas obligatorias para depurar Guardian Cloud sin destruir estabilidad.

Objetivo:
- proteger invariantes críticas,
- evitar regressions emocionales,
- impedir debugging caótico,
- mantener recovery estable.

---

# PRINCIPIO CENTRAL

Guardian Cloud NO es una app de grabación.

Es una app de SUPERVIVENCIA DE EVIDENCIA.

Prioridad real:

```txt
subida > grabación perfecta
recovery > UX
supervivencia > hacks
1. NO TOCAR RECOVERY SI YA FUNCIONA

Recovery es sistema crítico.

Si:

chunks sobreviven,
cola recupera,
sesiones completan,
uploads continúan,

→ recovery NO se toca.

Aunque exista:

bug visual,
limitación de librería,
edge-case raro.
2. LOGS PRIMERO. FIXES DESPUÉS.

Prohibido:

"creo que pasa esto"
"seguramente es..."
fixes intuitivos

Primero:

reproducir
aislar
loggear
confirmar flujo exacto

Solo después:

fix mínimo
scope mínimo
3. NUNCA TOCAR MUCHAS CAPAS A LA VEZ

Peligro rojo si un fix toca simultáneamente:

startRecording
stopRecording
recovery
chunkers
foreground service
AppState
upload worker

Eso multiplica estados imposibles.

4. SI EL BUG ES NATIVO → NO FORZAR SOLUCIÓN JS

Si el problema pertenece a:

Android lifecycle
expo-av internals
foreground service nativo
camera/audio native state

NO intentar resolverlo con:

refs
flags
resets masivos
timeouts
hooks React

Primero aceptar:
"puede ser límite estructural".

5. NO DEBUGGING EMOCIONAL

Señales de debugging emocional:

añadir fixes sin validar logs
cambiar múltiples cosas por frustración
insistir después de romper estabilidad
negarse a rollback
seguir tocando recovery a las 3 AM

Cuando aparezcan:
→ parar
→ volver al último tag estable

6. VOLVER ATRÁS RÁPIDO ES CORRECTO

Rollback NO es fracaso.

Rollback rápido:

protege el producto
protege invariantes
evita deuda tóxica

Insistir en fixes rotos por ego:

destruye semanas de estabilidad.
7. SI HAY TAG ESTABLE → USARLO

Antes de cualquier debugging serio:

crear:

branch temporal
o
stash limpio

Si algo rompe:
→ volver al tag estable inmediatamente.

Nunca debuggear directamente sobre baseline validado.

8. LOS LOGS DEBEN RESPONDER PREGUNTAS

Cada log debe existir para responder algo concreto.

Mal:

LOG START
LOG TEST
LOG HERE

Bien:

GC_QUEUE chunk uploaded
GC_BOOT_STALE_FG_DETECTED
GC_DIAG_PREPARE_REJECTED
9. NO CONFUNDIR SÍNTOMA CON CAUSA

Ejemplo real:

Síntoma:

Only one Recording object...

Causa real:

recorder nativo huérfano en expo-av

Error cometido:

tocar recovery
tocar chunkers
tocar quick-start

La cola NO era el problema.

10. TODO FIX DEBE RESPETAR INVARIANTES

Si un fix pone en riesgo:

upload en background
recovery
chunking
cola persistente
export

→ NO entra.

Aunque "arregle" otro bug.

11. LOS TESTS IMPORTANTES SON REALES

La validación real NO es:

TypeScript verde
Vitest verde
build OK

La validación real es:

kill app
mala red
background
reopen
recovery
uploads reales
Drive real
12. QUICK FIXES SON PELIGROSOS

Especialmente peligrosos:

flags extra
refs extra
guards reactivos
resets múltiples
lógica condicional en lifecycle

Cada fix rápido:
→ añade estados invisibles.

13. SI UN FIX NECESITA EXPLICACIÓN LARGA → PELIGRO

Regla práctica:

Si necesitas:

30 minutos para explicar el fix
múltiples diagramas mentales
muchos flags coordinados

probablemente:

estás parcheando arquitectura equivocada
o
luchando contra un límite del framework.
14. DOCUMENTAR LÍMITES REALES

Todo límite validado debe entrar en:

docs/KNOWN_LIMITS.md

Objetivo:

no repetir debugging
evitar amnesia técnica
proteger decisiones futuras
15. CUANDO PARAR

Parar inmediatamente si:

recovery deja de ser estable
aparecen chunks fantasma
uploads dejan de completar
foreground service entra en loops
ya no entiendes el estado real del sistema

En ese momento:

stash
rollback
volver al baseline
REGLA FINAL

Guardian Cloud no necesita ingeniería brillante.

Necesita:

supervivencia,
previsibilidad,
simplicidad,
estabilidad bajo estrés.

Todo lo demás es secundario.
