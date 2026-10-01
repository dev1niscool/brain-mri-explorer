import { Niivue } from '@niivue/niivue';

/** Keep MRI data available while omitting its invisible 3D volume pass. */
export class BrainSurfaceNiivue extends Niivue {
  surfaceOnly = false;

  drawImage3D(...args) {
    // NiiVue 0.62 still ray-marches loaded volumes at zero opacity. Only the
    // explicit surface view can skip that pass; slice/mixed views stay native.
    // Preserve the volume objects so camera bounds, MRI labels and processing
    // keep their original coordinates and state.
    if (
      this.surfaceOnly === true &&
      this.opts.sliceType === this.sliceTypeRender &&
      this.meshes.some(mesh => mesh.visible !== false && mesh.opacity > 0) &&
      this.volumes.every(volume => volume.opacity <= 0)
    ) return;

    return super.drawImage3D(...args);
  }
}
