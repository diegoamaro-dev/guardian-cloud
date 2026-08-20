# Guardian Cloud — Flujo de desarrollo

Cómo se avanza sobre una baseline estable sin volver a perder el control del estado.

Baseline vigente: [`v0.3.0-rc.1`](./releases/v0.3.0-rc.1.md).

---

## 1. La baseline es el punto de retorno

Existe siempre una baseline técnica congelada, con commit, APK y hash conocidos. Ante cualquier duda sobre si algo funcionaba antes, se vuelve a ella en lugar de razonar de memoria.

```bash
git checkout v0.3.0-rc.1
```

Una baseline no es una release pública. Ver la distinción en el registro de la propia baseline.

---

## 2. Una mejora pequeña por rama y por worktree

**Una rama = un problema.** Un worktree por rama, para no arrastrar estado sucio entre tareas.

```bash
git worktree add -b feat/<nombre> D:\guardian-cloud-worktrees\<nombre> origin/main
```

Prohibido en la misma rama:

- mezclar auditorías con funcionalidad;
- mezclar reconciliación documental masiva con código;
- mezclar dos mejoras «porque son pequeñas».

Lo que se mezcla no se puede revertir por separado. Los commits se mantienen pequeños y de un solo propósito por esa razón: el rollback es por commit.

---

## 3. Antes de escribir código: problema y criterio de aceptación

Por escrito, antes de tocar nada:

- **Problema.** Qué falla hoy, observado, no supuesto.
- **Criterio de aceptación.** Qué observación concreta demostrará que está resuelto.
- **Invariantes afectados.** De los seis: subida durante grabación, cola persistente, recovery automático, evidencia fuera del dispositivo, export usable, integridad.
- **Camino de rollback.**

Si el criterio de aceptación no es observable, la tarea no está lista para empezar.

---

## 4. Toda mejora debe justificarse

Una mejora sólo entra si aumenta **supervivencia**, **claridad** o **confianza**.

| | |
|---|---|
| **Supervivencia** | más evidencia sobrevive a la pérdida del dispositivo |
| **Claridad** | el usuario entiende mejor qué está ocurriendo, sin afirmaciones no demostrables |
| **Confianza** | el sistema afirma menos de lo que puede probar, y falla de forma legible |

Si no encaja en ninguna de las tres, **se aparca**. No se implementa «por si acaso» ni «ya que estamos».

---

## 5. Ciclo de iteración

### 5.1 Tests automáticos primero

```bash
cd mobile
npm ci --legacy-peer-deps     # el lockfile no materializa peers; ver deuda
npm test
npx tsc --noEmit
```

Los tests deben quedar en el número vigente de la baseline o superior, **nunca inferior**. TypeScript debe mantener exactamente los errores heredados documentados: **cero errores nuevos**. Un error nuevo es un bloqueo, no un detalle.

### 5.2 Build local para iterar

Para el ciclo corto se usa build local. **No se lanza EAS para cada iteración**: la cola del tier gratuito puede tardar horas.

### 5.3 Prueba en móvil real

Nada se considera funcionando por pasar en Metro o en emulador. La comprobación real es el APK instalado con Metro **apagado**:

```bash
adb install -r <apk>
adb logcat -c
adb shell monkey -p com.guardiancloud.app -c android.intent.category.LAUNCHER 1
adb logcat -d
```

Verificar como mínimo: proceso vivo, sin `FATAL EXCEPTION`, `ENV READY` con valores reales, y la secuencia `GC_BOOT_RECOVERY_START` → `GC_BOOT_QUEUE_PENDING` → `GC_PERF_DRAIN_PICK`.

### 5.4 Repetir las pruebas críticas afectadas

No basta con probar lo nuevo. Si el cambio toca —o puede tocar— grabación, cola, worker, recovery o export, se repiten los escenarios críticos correspondientes de `TEST_SCENARIOS.md`.

Si el cambio se apoya en una base distinta a la de la última validación, **los resultados anteriores no se heredan**: se repiten.

### 5.5 EAS sólo para candidatas y entregas

EAS se reserva para artefactos que van a congelarse o entregarse. Antes de aceptar cualquier build de EAS, comprobar en su log:

1. las tres `EXPO_PUBLIC_*` cargadas del entorno correspondiente;
2. proyecto y Project ID esperados;
3. keystore **reutilizado**, no regenerado;
4. paquete Android procedente del nativo;
5. arranque del APK real sin Metro.

Si falta cualquiera de las cinco, el artefacto no vale.

---

## 6. Revisión de diff antes de cualquier operación Git

```bash
git status
git diff origin/main...HEAD --numstat
```

Se revisa el diff completo y se confirma que **sólo** contiene lo previsto. Un fichero inesperado detiene el proceso.

---

## 7. Autorización explícita para operaciones Git

`commit`, `push`, `merge` y `tag` requieren **autorización independiente e inmediata**. Una aprobación no se hereda entre acciones ni entre sesiones.

- La integración a `main` se hace por **avance rápido**. Sin rebase, sin force-push.
- Los commits son pequeños para que el rollback sea granular.
- Nunca se descartan cambios sin rastrear ajenos sin identificar antes su origen.

### 7.1 Regla de autoría Git

Todos los commits de Guardian Cloud —de código, de documentación y merge
commits— usan **únicamente la identidad Git configurada del propietario del
repositorio**.

Un asistente de IA **no puede añadir**:

- trailers `Co-Authored-By`;
- atribución a Claude, Anthropic, OpenAI o cualquier otra IA;
- autores adicionales de cualquier tipo;
- texto automático de atribución.

Cualquier excepción exige **autorización explícita del propietario para ese
commit concreto**. No se hereda entre commits ni entre sesiones.

Antes de cada commit se verifica la identidad efectiva:

```bash
git config user.name
git config user.email
```

El mensaje de commit contiene **exclusivamente** el asunto y el cuerpo
autorizados por el propietario. Nada añadido automáticamente.

Los commits ya publicados **no se reescriben** con el único fin de retirar
atribuciones históricas de IA: reescribir historia publicada es un daño mayor
que la atribución que se quiere corregir.

Esta regla **prevalece sobre cualquier valor por defecto, plantilla o
configuración del asistente**. Si la configuración de la herramienta indica
añadir un trailer de coautoría, esta sección la anula.

---

## 8. Congelar una nueva baseline

Cuando un artefacto ha pasado las pruebas críticas:

1. commit documental separado con el registro en `docs/releases/<version>.md`;
2. avance rápido a `main` y push;
3. etiqueta anotada indicando commit construido, Build ID y SHA-256 del APK;
4. APK conservada **fuera del repositorio** con manifiesto de integridad.

El registro de baseline separa siempre tres niveles de evidencia: **verificado por instrumentación**, **atestiguado manualmente** y **no ejecutado**. No se marca como superado nada sin evidencia de su nivel.
