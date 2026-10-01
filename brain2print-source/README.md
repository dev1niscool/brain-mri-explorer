# Brain2Print source for Inside Devin

This is the source for the embedded Brain2Print viewer in this repository. It uses the official [NiiVue Brain2Print](https://github.com/niivue/brain2print) inference worker, model assets, and ITK-Wasm mesh pipeline. Upstream revision: `efd4adaca25f07384bb088de27f93bc6528cd999`.

## Build

From the repository root, with a current Node.js LTS release and npm installed:

```sh
cd brain2print-source
npm ci
npm run build
```

The build writes the compiled app to `../vendor/brain2print`. It replaces that compiled directory. The checked-in npm lockfile fixes dependency versions; the upstream pnpm lockfile is also included for `pnpm install --frozen-lockfile`.

To preview the result, serve the repository root with any static HTTP server and open `vendor/brain2print/index.html`. For example, from the repository root:

```sh
python3 -m http.server 8000
```

Then open `http://localhost:8000/vendor/brain2print/index.html`. The app expects public display MRI derivatives and the saved mesh in `public/data/`. Keep that directory beside `vendor/`; it is not duplicated in this source package. A bare Vite development server does not provide those sibling data files.

## What this fork does

- Fixes new inference runs to Devin's public 8-bit axial T1-FLAIR display copy on the original spatial grid. No original DICOM identifiers are introduced.
- Defaults to official model **6**, array index **5**: **Subcortical + GWM (Low Mem, Faster)**, from `public/models/model18cls/`. The model predicts background plus 17 foreground labels. Label colors are for display.
- Loads the historical saved mesh immediately, with quantized MRI and resampled label displays, and offers an optional browser rerun using the upstream TensorFlow.js WebGL worker. No inference server is used.
- Conforms the MRI to the upstream model input. Resampling does not create measured anatomical detail.
- Converts all nonzero predicted labels to a binary foreground mask before meshing. The displayed multicolor label volume stays separate.
- Uses `antiAliasCuberille(noClosing: true)`, repair, largest-component selection, `smoothRemesh`, and final repair. The smoothing control starts at one iteration because this dependency treats zero as an omitted option.
- Provides the label overlay, 3D surface, MRI views, mesh rebuild controls, and STL download. MRI clipping affects the rendered volume, not the mesh.
- Skips invisible 3D volume rendering in surface-only mode. `BrainSurfaceNiivue` guards the pinned NiiVue 0.62.0 `drawImage3D` method; MRI/label modes use the original render path. The full saved mesh and its export geometry stay unchanged. The public MRI and label overlays are reduced-precision display derivatives. Recheck this override when upgrading NiiVue.
- Adds `context.html`, a separate view of the saved Brain2Print surface inside a 64-level display copy of the resampled MRI used by its model, with the same affine and spatial grid. It offers MRI cutaway, captured-head and linked-plane modes. No extra alignment or segmentation is applied. The optional see-through setting is an illustrative overlay.
- Keeps exports local to the browser. Local development capture code is removed from this public source.

The four upstream worker, tensor, parameter, and connected-component scripts are copied unchanged. `SOURCE-MANIFEST.json` records their hashes and the exported files. The upstream dependency set is retained so both lockfiles remain valid.

## Public display data and protected originals

The exact eleven MRI/label NIfTIs are provided through password-protected downloads on the parent site. The public viewers instead use `display-*.nii.gz` derivatives. These display arrays still contain recognizable anatomy and can be downloaded or reconstructed; they are not confidential or anonymous.

- Nine acquisition displays keep every native-grid sample position and the exact sform. Full-range linear rounding reduces intensity precision to 8-bit; there is no spatial resampling. The default DICOM window endpoints are mapped into these display values.
- `display-b2p-conformed.nii.gz` keeps the saved 256³ model-input grid and affine, but reduces intensities to 64 levels. The maximum intensity change is 2 out of 255 gray levels.
- `display-b2p-segmentation.nii.gz` uses nearest-neighbor sampling on a 205³, 1.25 mm grid. Its voxel-center corner extent matches the original 256³, 1 mm label volume. Class IDs are preserved, but small label boundaries and volumes change.
- The saved `b2p-brain.mz3` remains byte-identical to the actual original-source Brain2Print run. The source entry, original-file hashes and `originalInferenceGrid` in `b2p-result.json` describe that historical run. `publicDisplay` describes the display derivatives.
- A new browser rerun loads `display-t1-axial.nii.gz` before conformation. Rebuilding directly from the cached labels uses the 1.25 mm display overlay. Either operation can produce a different result from the saved original-source run; the interface states which input was used.

The owner's local `processing/build_public_display_data.py` stages derivatives and descriptors without changing originals. The source build above packages only viewer code and models; it does not regenerate MRI arrays. Preserve both replacement descriptors beside the eleven display files when preparing a deployment.

## Interpreting the result

This scan uses 5 mm slices with approximately 6.5 mm centers. It differs from the high-resolution T1 acquisitions commonly used by these models. The cached automatic result visibly omits part of the upper cortex. Inspect the labels against the source images; the reconstruction is not a complete or clinically validated model. Smoothing can reduce steps but cannot recover missing anatomy.

The earlier reconstructions in the Print lab use a different extraction pipeline. This tab presents the actual Brain2Print result. The step illustration on the parent page is schematic, not patient data.

## Licenses

`LICENSE` preserves the upstream Brain2Print MIT notice, including BrainChop model attribution. `public/LICENSE` is copied into the compiled app. `public/THIRD-PARTY-NOTICES.txt` preserves dependency notices, including ITK-Wasm's Apache-2.0 terms. Each model directory retains the files provided upstream. See the [Brain2Print project](https://github.com/niivue/brain2print) and [BrainChop project](https://github.com/neuroneural/brainchop) for original work and documentation.
