# Inside Devin

A personal MRI exhibit: a rotatable Brain2Print reconstruction, brain-in-MRI cutaways, original and linked axial/coronal/sagittal images, interactive MRI volume rendering, 3D-print downloads, and geometric model statistics.

## Run locally

This is a static site with vendored Three.js 0.186.1. No package installation or build is required.

```sh
python3 -m http.server 8765
```

Open `http://localhost:8765/`. Serve this folder over HTTP; browser modules and volume fetching will not work by opening the HTML as a local file. GitHub Pages publishes `main` from the repository root. `.nojekyll` preserves all static assets.

## Interface

The five tabs are **Devin’s Brain**, **Slice Studio**, **Volume Studio**, **Print lab** and **Statistics**. Devin’s Brain is the landing view. Existing links to these views open their named tabs; the logo, the former `#explore` link and unrecognized links return to the landing view. The former Explore tab and its renderer have been removed. Print lab loads its own model preview when needed.

The landing page also includes a lazy-loaded MRI cutaway using the saved brain mesh and its matching conformed T1 volume. Its print section offers the exact 96,828-triangle surface and a 40,000-triangle compact STL, both in original millimeter coordinates, plus a size planner and slicer instructions. `public/data/b2p-print-editions.json` records mesh checks and sampled simplification differences. These checks do not establish anatomical accuracy; the automated reconstruction remains incomplete near the upper cortex.

The site uses dark navy translucent panels, blue and mint accents, and a 2.5-second pixel-brain welcome animation. Escape dismisses it; there is no skip button. Visitors who request reduced motion get a brief static introduction. MRI models load independently, so a slow request does not trap the visitor behind the intro.

Entering Print lab plays a 1.3-second illustrative printer animation using `public/images/captured-head-preview.png`, a saved image of the captured-head model. The static preview keeps this animation independent of the removed Explore renderer. It waits for the welcome screen and image to finish loading, can be dismissed with Escape, cancels when leaving the tab, and is omitted for reduced motion. There is no skip button. It does not simulate a real slicer toolpath.

Slice Studio opens in **Original slices** mode. Its axial T1, coronal FLAIR, and sagittal T1 panels show each acquisition’s own 512 × 512 pixel grid, with no spatial resampling. They are separate acquisitions: contrast and slice positions differ, and they are browsed independently. Intensity values are windowed into 8-bit browser previews; this does not alter the source files. All three image windows remain centered and preserve physical proportions.

**Linked volume** samples public 8-bit display copies on the original native grids, using each file’s sform affine and linear interpolation. Spatial dimensions and affines are unchanged; full-range intensity quantization removes the original scalar precision. Normal-window differences are at most 1–2 of 255 gray levels. It avoids the older spatially resampled 1.25 mm intermediate preview. Crosshairs connect three RAS planes in one selected volume. The Axial · T1, Coronal · FLAIR and Sagittal · T1 shortcuts select the acquisition with finer sampling in the preferred direction; they change the source for all three views together. They do not fuse acquisitions. Thickness and spacing still limit the other two directions. The 0.5 mm navigation grid represents interpolated positions, not acquired resolution. The axial tilt control rotates only the displayed image, crosshairs and direction markers; click locations are mapped back to the same RAS navigation positions. It does not register anatomy or modify MRI files. The initial axial T1 view uses an approximate +6° clockwise display adjustment, supported by checks across central slices. Other sequences start at their native angle. Each sequence remembers its manual adjustment while the page is open. Native angle restores the original display orientation.

The **Devin’s Brain** tab opens a saved result computed from Devin’s scan with the actual Brain2Print pipeline. Visitors can compare predicted tissue and subcortical labels with the MRI, use the label legend, rotate the surface, download its STL, or rerun the model on their own device. A compact illustration with 01–04 buttons below the viewer explains the scan-to-labels-to-mesh process; its schematic shapes are separate from the actual MRI result. Print lab makes this Brain2Print surface the primary download. The earlier HD-BET brain and its fitted stand remain under “Earlier reconstruction & stand,” and Statistics continues to measure the HD-BET brain and captured-head models.

## Volume Studio

The third tab renders the axial T1 MRI directly with an original WebGL 2 ray marcher. Whole-head and approximate brain-only views offer translucent compositing, summed-signal “X-ray” style and maximum intensity projection. Opacity, tissue floor, brightness ceiling, rendering quality and a sagittal cut are adjustable. The cut removes patient-right first; front, side and top presets preserve physical proportions. Drag, pinch/scroll and keyboard controls share the same camera.

It reuses `t1-axial.raw.gz` and the aligned `brain-mask.raw.gz`: 221 × 241 × 197 voxels at 1.25 mm, x-fastest RAS, about 2.48 MB compressed together. Intensities are the earlier windowed 8-bit previews. The brain mask is the filled, smoothed HD-BET printable envelope, not the separate Brain2Print label result or a validated tissue boundary. The data preserve the original 29-plane acquisition’s limitations: 5 mm slices with approximately 1.5 mm gaps. Interpolation makes the volume continuous but cannot recover missing measured detail. “X-ray” is a display effect on MRI signal, not an actual X-ray or bone segmentation.

Physical box dimensions come from voxel dimensions and spacing. Camera presets frame the occupied signal bounds (above 5% preview intensity) without changing the rendered data. MRI, mask and clipping share one transform; mask bytes are normalized from 0/1 to 0/255 before texture upload. Opacity integration accounts for physical ray step size. Rendering occurs only on changes, drops resolution during dragging and restores it afterward, and pauses while the view or document is hidden. Data and renderer load on first opening the tab; loading failures offer a retry.

The control concept was inspired by [Max Allison’s MRI viewer](https://maxballison.com/). No source code or scan assets from that site are included.

## Dataset and privacy

The owner explicitly authorized public release of the full head and face, and the credit “Devin’s head MRI · September 29, 2026.” These facial images and this attribution can identify the owner. **The collection has identifying metadata removed; it is not anonymous.**

The private DICOM archive contains 278 images in nine original acquisition series, along with a README and audit report. It is no longer served by the public site. A technical allowlist excludes direct patient identifiers, institutional and device identifiers, original dates/times, private elements, free-text descriptions, references and overlays. Study, series, instance, and frame-of-reference UIDs are replaced. Output pixels were checked against all 278 originals and are unchanged. Contact sheets and local OCR were reviewed for burned-in text; none was identified. This is not a formal de-identification certification.

Original DICOMs, DICOMDIR, the viewer bundle, local segmentation environment and local working/audit files are outside this repository. The full reproducible processing scripts are in the owner's separate local `processing` folder. A reference to that folder in the private archive README refers to the local project, not an omitted web dependency.

## Protected downloads

`nifti-downloads.js` opens an accessible password dialog for all 11 NIfTIs and the collection ZIP. The password is sent over HTTPS in an Authorization header to the endpoint in `download-service.json`; it is never saved in browser storage or included in a URL. Each download asks again. Incorrect passwords and rate limits display a retry message; cancellation aborts the request.

The Cloudflare Worker checks a secret, a fixed file allowlist and an IP rate limit before fetching any bytes. All routes run the Worker first, including direct asset paths. Responses use attachment filenames and no-store headers. Large collection parts are streamed back as the exact original ZIP. Service source, security tests and deployment instructions are in [download-service](download-service/README.md). The asset bytes and password are kept outside this public repository.

The 3D models and viewing data remain public by the owner’s choice. Public display volumes intentionally contain less intensity precision; the Brain2Print display labels also have a coarser grid. The original saved mesh and downloadable STLs are unchanged. Password protection limits access to the original files, not the anatomy visible on the website, and cannot revoke copies obtained before protection was enabled.

The former public repository is retained as a private archive. This repository starts from a clean snapshot without the protected originals in its Git history.

## Imaging and surface methods

See [the manifest](public/data/manifest.json) for exact dimensions, transformations, model methods and limitations, and [the audit report](public/data/deidentification-report.json) for privacy checks.

- **Nine browsable volumes:** axial and sagittal T1-FLAIR, axial T2, axial and coronal T2-FLAIR, axial MERGE, two diffusion stacks and ADC. The three-plane localizer remains in the DICOM archive but is unsuitable as one coherent browser volume. Splitting the diffusion series into its two stacks yields nine browsable volumes.
- **Protected native NIfTI downloads:** retain source scalar values and acquisition geometry in fresh metadata. The source acquisitions are oblique and anisotropic. The originals are served by the separate Cloudflare download service after a server-side password check; they are absent from this public repository.
- **Original-slice browser data:** the three native arrays retain their acquired pixel grids, with only canonical axis swaps/flips and pointwise 8-bit windowing. `native-series.json` describes the displayed axes, dimensions, and physical spacing. Each displayed plane has 0.4688 mm pixel spacing; source slices remain 5 mm thick and approximately 6.5 mm apart.
- **Linked-volume browser data:** `display-*.nii.gz` files retain native geometry with quantized 8-bit intensity values. `linked-series.json` records provenance, dimensions, affines, acquired planes and remapped display windows. A 0.5 mm RAS navigation grid covers the native voxel-center bounds; windowing follows interpolation. ADC brightness is a display value, not a quantitative ADC readout. These display copies are intentionally public and can be retrieved or reconstructed by a visitor. They are not substitutes for the protected original-precision files.
- **Earlier preview data:** the 1.25 mm RAS uint8 previews and matching brain mask were generated for the former Explore cross-section viewer. Volume Studio reuses these assets for direct volume rendering; they remain separate from the native-data Linked volume viewer.
- **Coordinate frame:** +X is patient Right, +Y Anterior, +Z Superior. The HD-BET brain, captured-head meshes and earlier preview volume share a brain-centered physical frame. Linked volume retains the original NIfTI scanner coordinates. Slice Studio uses radiological display (patient right on screen left for axial/coronal; anterior on screen left for sagittal). Sequence switching preserves scanner coordinates but performs no motion correction. The Brain2Print mesh, its fitted stand and matching MRI use their own shared NIfTI RAS world coordinates.
- **HD-BET brain:** local HD-BET v2 on axial T1-FLAIR, followed by conservative low-signal exclusion, connected-component cleanup, enclosed-hole filling, smoothing and simplification. This creates an approximate tissue envelope, not a validated cortical or lobe segmentation.
- **Head:** sagittal T1-FLAIR thresholding, component cleanup, closing, hole filling and smoothing. It represents captured outer soft tissue, including facial anatomy. The lower face/neck is cropped by the source field of view and closed for printing. It does not represent segmented skull bone. The brain and head acquisitions have not been motion-registered to each other.
- **HD-BET brain and captured-head files:** each whole-model STL uses millimeters, 120,000 triangles, one connected component, consistent winding and a watertight surface. Their GLB files use meters. These checks describe the generated objects; slicer review and supports are still necessary. The separate Brain2Print result uses the method below and has its own mesh properties.

The anatomical acquisitions use **5 mm slice thickness with approximately 1.5 mm gaps**. Interpolation and smoothing do not recover missing detail. Horizontal ridges or other surface patterns can reflect the sampling. The pink brain material is illustrative: MRI does not capture tissue color. Brain2Print label colors show automated tissue and structure estimates, not individual lobe boundaries. No medical diagnosis, clinical measurement, or functional inference is made.

## Surface refinement

The HD-BET brain and captured-head models reduce systematic slice terracing with Gaussian smoothing of the signed-distance field. The kernel follows each source acquisition’s actual oblique slice normal: 3.5 mm sigma through the slices and 1.25 mm within the slice plane. The zero isosurface is extracted, mildly Taubin-smoothed, and simplified. No template anatomy or global rescaling is applied. The retained brain cut mask follows the refined HD-BET surface in the earlier browser grid. This refinement method is separate from the Brain2Print processing described below.

The previous models are preserved locally for comparison. The signed-distance revision changed enclosed model volume by about −0.45% for the brain and −0.11% for the head. A later 100-pass nonshrinking Taubin finish softens small facets on the brain. It retains the same 120,000 triangles and topology; nearest-surface movement from that previous brain is a median 0.050 mm, 95th percentile 0.152 mm, and maximum 0.543 mm. Model volume changes by +0.114%. These are differences between generated objects, not anatomical accuracy measurements. Smoothing also removes some small details and cannot reconstruct missing cortical folds. Parameters and comparison metrics are in the model manifest.

## Print lab and display stand

Print lab opens on the full-detail Brain2Print brain and previews the actual downloadable STL geometry. Its primary options are the Brain2Print brain, its matching stand kit, and the captured head. The earlier HD-BET brain and stand remain available under “Earlier reconstruction & stand.” Camera controls support dragging, scrolling, arrow keys, plus/minus, and Home. Pink surface shading is illustrative; the stands preserve flat face normals for crisp edges and lettering.

The primary brain STL, `public/data/b2p-print-full.stl`, preserves the saved 96,828-triangle Brain2Print surface. A separate 40,000-triangle compact edition is available for a lighter file. “Full detail” distinguishes the original surface from the simplified edition; both retain the reconstruction’s incomplete upper-cortex coverage.

The Brain2Print stand has three broad fitted pads, a flat plinth and an embossed sloped nameplate. It is fitted to the exact full-detail Brain2Print STL, whose SHA-256 is recorded in `public/data/b2p-display-stand.json`. This descriptor also records dimensions, topology, sampled clearance, intersection and removal checks, and stability estimates. Brain and stand share unchanged NIfTI RAS world coordinates. `b2p-display-kit.zip` contains the full brain, `b2p-display-stand.stl` and print notes. The compact edition and HD-BET brain are not the fitted references for this stand.

The earlier HD-BET brain has its own fitted `brain-display-stand.stl`, documented with source hashes in `public/data/print-edition.json`. That brain and stand share centered RAS coordinates. Optional left and right pieces split the HD-BET brain at the geometric RAS x=0 plane, cap the cuts, and orient each flat face on z=0. They are printing pieces, not separately segmented anatomical hemispheres. Join them before putting the brain on its stand. `brain-display-kit.zip` contains the whole HD-BET brain, both alternative pieces, its stand and print notes. Neither kit contains MRI volumes.

Use each brain with its matching stand. Drop the stand to the bed in a slicer and print both at the same scale. Digital fit and stability checks do not replace a physical test print; none has been performed.

The [Reddit project](https://www.reddit.com/r/3Dprinting/comments/qpd6my/my_friend_had_to_get_an_mri_of_his_head_we/) inspired the removable display and split-print option. Its creator describes manual segmentation, smoothing, cleanup and a custom stand. The [Brain2Print tutorial](https://www.youtube.com/watch?v=_etI1yMVegg) demonstrates segmentation and printing at reduced scale. The [Slicer tutorial](https://www.youtube.com/watch?v=k1WIpwV-8lE) uses a sample MRI and includes artistic mesh sculpting. Their appearance does not establish the achievable accuracy of this thick-slice scan. All 278 supplied DICOM images were checked: no supplied series is a thin-slice 3D anatomical volume. [FreeSurfer's guidance](https://surfer.nmr.mgh.harvard.edu/fswiki/FreeSurferBeginnersGuide) describes approximately 1 mm isotropic T1 data for detailed cortical reconstruction.

## Statistics

The Statistics tab measures the earlier printable **HD-BET brain** and captured-head meshes; its values do not describe the Brain2Print result on the landing page. Fixed orthographic views show the exact axis-aligned bounds, with millimeter/centimeter controls. Enclosed model volume, span proportions, and an equal-volume sphere provide scale comparisons. The HD-BET brain model includes filled internal spaces; its enclosed volume is not gray-plus-white tissue volume. The head includes face/scalp and a closed lower crop boundary, so its volume is not complete head volume or intracranial capacity.

`public/data/statistics.json` records source STL hashes, definitions, geometric checks, and 25 upper-head contours. The local `processing/build_statistics.py` generator selects constant-RAS-Z planes at evenly spaced fractions from 60% to 95% of captured head height. The default is the fixed midpoint of that band, not a level chosen for roundness. For each largest closed loop, area and perimeter use the full section, and length/width use its minimum-area enclosing rectangle. SVG outlines are simplified within 0.2 mm. The equal-area circle is a mathematical comparison. Neither the shape ratio nor the model spans constitute a clinical cephalic index.

Box, rotated rectangle, circle and ellipse checks verify units and formulas. All 25 loops are closed and valid; regeneration is deterministic with the recorded dependency versions. These validate calculations on the reconstructed objects, not anatomical accuracy. The tab withholds cortical thickness, cortex/tissue ratios, brain/head occupancy ratios and personal population percentiles. The existing Brain2Print segmentation misses some upper cortical tissue, and published tissue-volume norms do not measure the closed printable envelope. The [Brain Charts FAQ](https://github.com/brainchart/Lifespan/blob/main/FAQ.md) also requires a calibrated site/protocol baseline for individual centiles.

## Brain2Print

The first tab is titled “Devin’s Brain.” Its footer credits Brain2Print and links to the team’s [2025 paper in Scientific Reports](https://www.nature.com/articles/s41598-025-00014-5), a Nature Portfolio journal. The publication credit refers to the software.

The dedicated tab embeds an adaptation of [niivue/brain2print at commit `efd4adaca25f07384bb088de27f93bc6528cd999`](https://github.com/niivue/brain2print/tree/efd4adaca25f07384bb088de27f93bc6528cd999). Its saved segmentation and mesh were computed from Devin’s axial T1-FLAIR scan. The same model can run again in the visitor’s browser using TensorFlow.js and WebGL, subject to the device’s graphics and memory limits. The saved result can be explored without rerunning inference. The viewer exports STL. At the owner’s request, links beneath “Made with Brain2Print” offer all 11 original NIfTI files individually and together as a ZIP, alongside brain2print.org. Every download opens a password dialog and calls the separate Cloudflare service; no password, verifier or original file bytes are embedded in the public site. The nine scan volumes preserve their stored resolution; the two Brain2Print outputs are the resampled input MRI and predicted label volume. The ZIP contains those exact files and a README explaining their provenance and geometry. Experimental local intermediates are not additional acquisitions and are not included. The three-plane localizer remains in the DICOM archive because it is not one coherent 3D volume.

- **Model:** official model ID 6, array index 5, **Subcortical + GWM (Low Mem, Faster)**, with weights from `models/model18cls/model.json`. Its 18 classes comprise background/unknown plus 17 predicted tissue and structure labels. These include gray and white matter, ventricles, cerebellar tissue and subcortical structures; they do not provide individual cortical lobe boundaries. The public overlay uses a nearest-neighbor display copy at 1.25 mm, retaining the original label IDs and world-coordinate extent. Its boundaries are approximate and can shift; the original label volume is available only through the protected download. The upstream BrainChop inference code and model weights are unchanged.
- **Mesh input adaptation:** a separate binary array treats every nonzero predicted label as foreground. This union prevents multiclass label numbers from being interpreted as scalar intensities by surface extraction. It does not change the displayed label volume.
- **Mesh processing:** the ITK-Wasm quality path uses anti-aliased cuberille extraction, repair, largest-component selection, smoothing/remeshing with 3 iterations and a detail setting of 25, then a second repair. Visitors can change the smoothing and detail settings and rebuild the surface. No niimath mesh path is used in this adaptation.
- **Observed limitation:** this model gave the best coverage among the three models compared locally, but the result still omits part of the upper cerebral cortex. It is an incomplete automated reconstruction, not a complete or clinically validated map of Devin’s brain. The source has 5 mm slices with gaps; resampling and smoothing cannot recover missing measured detail or validate predicted boundaries.

The interface, source paths, cached-result loading, cancellation and error handling are adapted for this exhibit. Reproducible source and build instructions are in [brain2print-source](brain2print-source/README.md). The bundled [MIT license](vendor/brain2print/LICENSE) and [third-party notices](vendor/brain2print/THIRD-PARTY-NOTICES.txt) retain upstream and dependency attribution. This Brain2Print result is the primary Print lab model. The separate HD-BET reconstruction remains an earlier print option and is the brain model measured by Statistics.

## Sources and credits

- [NIMH — Get to Know Your Brain](https://www.nimh.nih.gov/news/media/2023/get-to-know-your-brain)
- [NIBIB — Magnetic Resonance Imaging](https://www.nibib.nih.gov/science-education/science-topics/magnetic-resonance-imaging-mri)
- [DICOM — Attribute Confidentiality Profiles](https://dicom.nema.org/medical/dicom/current/output/chtml/part15/chapter_E.html)
- [HD-BET](https://github.com/MIC-DKFZ/HD-BET); [brain extraction paper](https://doi.org/10.1002/hbm.24750)
- [Brain2Print paper](https://doi.org/10.1038/s41598-025-00014-5)
- Three.js: [MIT license](vendor/THREE-LICENSE.txt)

The website has no accounts, analytics or tracking cookies. Its imaging interactions run in the visitor's browser after downloading the public assets. External reference links open their respective websites only when selected.

## Home-screen icons and link previews

The home-screen icon, favicon, and sharing banner reuse the pink pixel brain from the welcome animation. `site.webmanifest` keeps installed shortcuts inside `/brain-mri-explorer/` and opens Devin’s Brain. iOS also has an explicit 180-pixel Apple touch icon; other launchers have 192- and 512-pixel icons and a separate maskable version.

Open Graph and Twitter card metadata are in the initial HTML, so messaging apps can read them without running JavaScript. The 1200 × 630 PNG sharing image is an illustration, not an MRI rendering. It uses an absolute HTTPS URL and stays below 1 MB. The site requires a connection; no offline cache or service worker is installed.
