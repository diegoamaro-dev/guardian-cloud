package com.guardiancloud.segrec

import android.content.Context
import android.util.Log
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.ViewGroup
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView

/**
 * SPIKE — P2 early gate. Preview surface only.
 *
 * The view owns nothing but the `Surface`. Capture policy, rotation and
 * segment lifetime live in the module and the coordinator — the UI layer never
 * decides when to rotate.
 *
 * Surface lifecycle drives camera release: when the surface is destroyed the
 * module tears the session down, so unmounting the view always frees the
 * camera.
 */
class GCSegmentedCameraView(context: Context, appContext: AppContext) :
  ExpoView(context, appContext) {

  val surfaceView = SurfaceView(context).also {
    it.layoutParams = ViewGroup.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.MATCH_PARENT,
    )
    addView(it)
  }

  var onSurfaceReady: ((android.view.Surface) -> Unit)? = null
  var onSurfaceLost: (() -> Unit)? = null

  init {
    surfaceView.holder.addCallback(object : SurfaceHolder.Callback {
      override fun surfaceCreated(holder: SurfaceHolder) {
        Log.i(TAG, "GC_P2_GATE preview_surface_created")
        onSurfaceReady?.invoke(holder.surface)
      }

      override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
        Log.i(TAG, "GC_P2_GATE preview_surface_changed ${width}x$height")
      }

      override fun surfaceDestroyed(holder: SurfaceHolder) {
        Log.i(TAG, "GC_P2_GATE preview_surface_destroyed")
        onSurfaceLost?.invoke()
      }
    })
  }

  companion object {
    private const val TAG = "GCSegRec"
  }
}
