Mitigating Tracking Divergence in Multi-Object Drosophila Analysis: Cross-Platform Bit-Exact Video Decoding and Robust Assignment Algorithms

## Introduction to the Methodological Challenge

In the computational analysis of Drosophila melanogaster (fruit fly) locomotion, preserving the absolute identity of individual specimens across continuous, long-term video recordings is a foundational requirement for rigorous behavioral phenotyping. Researchers depend on high-throughput, classical multi-object tracking algorithms to correlate distinct kinetic signatures with underlying genetic mutations, neurobiological variables, or age-related motor performance declines. From assessing negative geotaxis—the innate response to climb against gravity—to quantifying intricate social and courtship interactions, the validity of the resulting biological data hinges on the uninterrupted tracking of each individual within an arena.

However, a persistent and critical failure mode in multi-object tracking emerges during close-proximity spatial interactions, such as crossing trajectories or physical collisions. During these events, the discrete morphological boundaries of the subjects frequently merge into a single foreground blob in the binarized image space. Under these conditions, the discrete identities of the subjects become highly susceptible to swapping. To mitigate this, classical algorithms rely heavily on centroid distance calculations.

When deploying these classical nearest-neighbor tracking pipelines across heterogeneous computational environments—such as a local Microsoft Windows workstation for prototyping and a Linux-based Google Colab instance for batch processing—practitioners frequently observe macroscopic tracking divergences. Despite processing an identical MP4 video file with a verified SHA-256 hash, an identity swap may reliably occur on one platform while successfully maintaining identity on the other. Because tracking errors cascade sequentially, a single platform-dependent identity swap at frame $N$ results in a permanent inversion of trajectories, culminating in massive root-mean-square error (RMSE) divergences exceeding 75 pixels over the course of the recording.

This cascading failure originates from sub-pixel to 1-2 pixel coordinate variances generated during the video frame decoding phase. When two subjects are nearly equidistant from a reference point during a crossing event, a minuscule 1-2 pixel coordinate perturbation tips the mathematical distance inequality, forcing a bipartite graph mismatch that permanently swaps the identities of the flies.

Addressing this cross-platform tracking divergence requires a bipartite architectural resolution. First, the video decoding pipeline must be rigidly standardized to guarantee 100% bit-exact, pixel-identical outputs across operating systems, stripping away the abstraction layers that introduce non-deterministic rounding. Second, the tracking logic must be fortified against minor spatial noise. While advanced methodologies like Active Shape Models (ASM) or Active Contour Models exist for collision resolution, they introduce severe computational overhead. Therefore, it is imperative to engineer a simple, lightweight kinematic modification to the existing nearest-neighbor assignment algorithm to render it immune to minor decoding noise during collision events. This report exhaustively investigates the underlying mechanics of cross-platform decoding variance, prescribes standard-package configurations for bit-exact parity, and outlines a robust mathematical modification to the assignment algorithm.

---

## Part I: The Architectural Mechanics of Cross-Platform Video Decoding Divergence

To guarantee pixel-identical frame decoding, it is critical to understand precisely why standard libraries like OpenCV produce divergent pixel matrices from mathematically identical compressed video files across different operating systems. The discrepancies arise from a complex hierarchy of hardware abstractions, backend negotiations, color space interpolations, and algorithmic approximations inherent in modern multimedia processing pipelines.

### Operating System Media Abstraction Layers and API Heterogeneity

OpenCV is an image processing library, not a native video codec engine; rather, it acts as a high-level wrapper around the underlying multimedia frameworks present on the host operating system. When the cv2.VideoCapture class is initialized without explicitly defining the application programming interface (API) backend, OpenCV automatically queries the system and defaults to the dominant media foundation available.

On Microsoft Windows, the default backend prioritized by OpenCV is typically DirectShow or the Microsoft Media Foundation (MSMF). These frameworks utilize proprietary, closed-source Windows-native decoders to parse the bitstream. Conversely, on Linux environments such as Google Colab or Ubuntu workstations, OpenCV defaults to Video4Linux (V4L), GStreamer, or FFmpeg. Because MSMF and GStreamer utilize fundamentally different low-level libraries and parsing logic to unpack the H.264/AVC or HEVC bitstream, the resulting decoded uncompressed frames will inherently exhibit minor, often sub-pixel, variations in their matrices.

### The Interference of Hardware Acceleration and Silicon Architecture

Even if the developer explicitly forces the backend to standardize on FFmpeg across both operating systems, hardware acceleration introduces a secondary, highly opaque layer of non-determinism. Modern multimedia libraries are engineered to automatically attempt to offload decoding tasks to the Graphics Processing Unit (GPU) or dedicated media Application-Specific Integrated Circuits (ASICs) to optimize throughput and minimize host CPU utilization.

Hardware decoders are manufacturer and platform-specific. Examples include NVIDIA's NVDEC (CUDA), Intel's Quick Sync Video (QSV), the Linux Video Acceleration API (VAAPI), and the Windows Direct3D 11 Video Acceleration (D3D11VA). These hardware blocks implement decoding mathematics directly in silicon. Consequently, floating-point operations, matrix multiplications, and Discrete Cosine Transform (DCT) rounding are subjected to the specific microarchitecture of the processing chip. Decoding an identical macroblock via a Windows workstation equipped with an NVIDIA GPU versus a Linux cloud instance utilizing an Intel CPU will yield 1-2 pixel variations. In the context of computer vision, these variations primarily manifest as compression artifact noise along high-contrast boundaries—such as the perimeter of a fruit fly's dark body against a bright laboratory background. When a classical tracker applies a binary thresholding or contour extraction operation to these divergent edge pixels, the computed centroid of the insect shifts by 1-2 pixels between platforms.

### Chroma Subsampling, Color Space Conversion, and libswscale Approximations

The most profound source of pixel divergence occurs during color space conversion. The vast majority of consumer and scientific video files utilize chroma subsampling, predominantly the YUV 4:2:0 format, to conserve storage and bandwidth. In this format, the luminance (Y) channel is stored at full resolution, dictating the brightness and structural detail, while the chrominance (U and V) channels are stored at a quarter resolution, exploiting the human eye's lower sensitivity to color detail. Because OpenCV tracking pipelines typically require a planar BGR24 (8-bit per channel) pixel matrix for processing, the decoded YUV frames must undergo interpolation and color space conversion.

When using the FFmpeg backend, this color space conversion and chroma upsampling is delegated to the libswscale library. The mathematical conversion from YUV to RGB requires matrix multiplication utilizing specific color coefficients (such as BT.601 or BT.709) and must account for color ranges (limited/TV range of 16-235 versus full/PC range of 0-255).

For maximum computational speed, libswscale heavily utilizes Single Instruction, Multiple Data (SIMD) instruction sets, such as MMX, SSE, and AVX, which are specific to the processor's architecture. To further accelerate processing, libswscale approximations replace precise floating-point matrix multiplications with integer bit-shifting algorithms. For example, instead of calculating a green pixel channel using precise floating-point coefficients, the library executes a mathematically proximal bit-shift optimization. While mathematically very close, this integer approximation introduces precision loss, especially on the green pixel channel where coefficients are heavily mixed.

Because Google Colab cloud instances (often utilizing specialized Intel Xeon or AMD EPYC architectures) and local Windows workstations (often consumer-grade Core i7 or Ryzen processors) possess different CPU architectures, the SIMD branching paths executed by libswscale diverge. Furthermore, in the simple, default, non-exact YUV-to-RGB conversion, the UV channels are upsampled using a fast nearest-neighbor conversion, meaning UV input samples are re-used 2x2 times for each output RGB pixel. This combination of integer rounding approximation and nearest-neighbor chroma upsampling guarantees that identical source videos will produce differing sub-pixel color interpolations and subsequent 1-2 pixel centroid shifts across different hardware environments.

---

## Part II: Engineering Bit-Exact Decoding Parity in Python Environments

Achieving 100% bit-exact pixel reproducibility requires explicitly eliminating the aforementioned variables by wrestling control away from the abstraction layers. The decoding pipeline must be forced into a strictly software-based, deterministically rounded, and hardware-agnostic process. Depending on the constraints of the deployed tracking software, three distinct methodologies can be employed using standard Python packages to enforce decoding parity.

### Methodology A: Constraining the OpenCV FFmpeg Backend via Environment Properties

The native OpenCV VideoCapture class can be constrained to produce identical results across platforms by explicitly dictating the backend, disabling all hardware acceleration, and injecting deterministic scaling flags via operating system environment variables. This approach requires no additional third-party dependencies beyond standard OpenCV.

First, the instantiation of the video capture object must bypass auto-detection. The developer must pass the explicit `cv2.CAP_FFMPEG` flag. Second, the property `cv2.CAP_PROP_HW_ACCELERATION` must be explicitly set to `cv2.VIDEO_ACCELERATION_NONE` during initialization. This forces OpenCV to utilize the software CPU decoder (e.g., libavcodec), ensuring that proprietary GPU architectures and API endpoints like DirectShow or V4L do not interfere with DCT calculations.

Third, and most critically, the libswscale SIMD variations must be suppressed. OpenCV allows the passage of internal configuration flags directly to the underlying FFmpeg instance through the `OPENCV_FFMPEG_CAPTURE_OPTIONS` environment variable. To eliminate architectural divergence, three specific sws_flags must be applied as a concatenated string:

| FFmpeg sws_flags | Mechanism of Action in Decoding Pipeline | Cross-Platform Stabilization Impact |
| :--- | :--- | :--- |
| **bitexact** | Disables any SIMD CPU optimizations (MMX/AVX) that do not generate the exact same output as the foundational C code implementation. | Eliminates architectural discrepancies between Windows local CPUs and Google Colab Xeon/EPYC processors. |
| **accurate_rnd** | Disables the fast 15-bit integer bit-shift shortcut traditionally used in YUV-to-RGB matrix multiplication, forcing highly accurate, slower mathematical rounding. | Eliminates precision loss across color channel interpolations, ensuring predictable BGR matrices. |
| **full_chroma_int** | Enforces Full Chroma Interpolation, upsampling the YCbCr 4:4:4 plane using actual scaling conversions before the RGB conversion is initiated. | Overrides the default fast nearest-neighbor chroma upsampling that causes blocky artifacts and edge noise. |

The precise Python implementation requires setting the environment variable prior to invoking the OpenCV module, followed by strict capture initialization:

```python
import os
import cv2

# Inject strict FFmpeg decoding flags into the environment to bypass default scaling
os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "sws_flags;bitexact+accurate_rnd+full_chroma_int"

# Instantiate VideoCapture with strictly defined API and disabled hardware acceleration
cap = cv2.VideoCapture(
    "drosophila_locomotion_assay.mp4", 
    cv2.CAP_FFMPEG, 
    [cv2.CAP_PROP_HW_ACCELERATION, cv2.VIDEO_ACCELERATION_NONE]
)
```

While this methodology is highly effective, it relies on the assumption that the libavcodec and libswscale versions statically compiled into the Windows OpenCV wheel and the Linux OpenCV wheel are behaviorally identical. If major version discrepancies exist between the pre-compiled binaries, marginal discrepancies may still theoretically emerge.

### Methodology B: Raw Data Piping via FFmpeg Subprocesses and Native Wrappers

To completely bypass OpenCV's opaque initialization sequence and black-box backend negotiations, a more scientifically rigorous approach involves leveraging FFmpeg natively. By utilizing libraries such as `ffmpeg-python`, `PyAV`, or `ffmpegio`, the uncompressed raw video frames can be piped directly into Python numpy arrays.

By executing FFmpeg as an independent subprocess, the developer exercises absolute, granular control over the decoding flags. The command instructs FFmpeg to decode the compressed stream, apply the deterministic swscale filters, and dump raw BGR24 byte data directly into the standard output (stdout) pipe. `ffmpeg-python` acts as a complex wrapper for constructing these command-line arguments programmatically. The configuration specifies the exact pixel format (`pix_fmt='bgr24'`) to match OpenCV's standard ordering, and applies the crucial scaling flags.

```python
import ffmpeg
import numpy as np

width, height = 1920, 1080
video_path = 'drosophila_locomotion_assay.mp4'

# Build an explicit, deterministic FFmpeg subprocess
process = (
    ffmpeg
    .input(video_path)
    .output('pipe:', 
            format='rawvideo', 
            pix_fmt='bgr24', 
            sws_flags='bitexact+accurate_rnd+full_chroma_int')
    .run_async(pipe_stdout=True, pipe_stderr=True)
)

# Read frames sequentially into a numpy array
while True:
    in_bytes = process.stdout.read(width * height * 3)
    if not in_bytes:
        break
    # Construct exact pixel matrix for tracking
    frame = np.frombuffer(in_bytes, np.uint8).reshape([height, width, 3])
    # Proceed with nearest-neighbor tracking algorithm...
```

When managing subprocess pipes, practitioners must be wary of operating system deadlocks caused by stdout or stderr buffers filling to capacity. The `run_async` method handles this gracefully, but buffer sizes must be managed for high-resolution video. Alternatively, the `ffmpegio` library abstracts these pipe mechanics entirely, allowing users to load highly specific frames into numpy arrays with a streamlined API, natively supporting the injection of raw `sws_flags`. For developers requiring the highest performance without the overhead of pipe transfers, `PyAV` provides direct Pythonic bindings to the underlying C-based `libavformat` and `libavcodec` libraries, bypassing the command-line interface entirely while still exposing the necessary bitexact scaling parameters.

### Methodology C: Transcoding to Uncompressed and Lossless Architectures

If configuring decoder backends yields persistent performance bottlenecks or cross-platform versioning conflicts, the most scientifically robust and infallible approach to achieving parity is to pre-decode the video into a mathematically lossless format prior to engaging the tracker. Standard compressed formats, particularly those utilizing chroma subsampling, are fundamentally lossy and require active spatial reconstruction and interpolation during playback.

By utilizing FFmpeg in a pre-processing step to transcode the source video into a lossless format—such as an uncompressed PNG image sequence or a video container utilizing the `libx264rgb` codec with a Constant Rate Factor (CRF) of 0—the pixel data is rendered absolute.

The `libx264rgb` encoder is specifically designed to accept packed RGB pixel formats. It utilizes a predictive coding scheme that yields a bit-for-bit identical image upon decompression, bypassing YUV chroma upsampling altogether during playback. When dealing with monochrome scientific video data typical of Drosophila assays, ensuring the pixel format is preserved eliminates all color-space conversion ambiguity.

The command to generate a lossless, platform-agnostic video utilizes the gbrp (planar RGB) output format, which ensures maximum compatibility and strict lossless reconstruction:

```bash
ffmpeg -i input.mp4 -c:v libx264rgb -crf 0 -pix_fmt bgr24 lossless_drosophila.mkv
```

When OpenCV executes VideoCapture on `lossless_drosophila.mkv`, no spatial matrix interpolations, SIMD scaling, or hardware acceleration negotiations are required. The pixel matrix is simply copied byte-for-byte from the MKV container into system memory, effectively guaranteeing zero divergence between Windows and Linux deployments, regardless of the underlying hardware microarchitecture.

---

## Part III: Vulnerabilities in Classical Tracking and Assignment Architectures

While achieving bit-exact decoding eliminates the environmental trigger for cross-platform divergence, the underlying algorithmic fragility of the classical nearest-neighbor tracking logic must be simultaneously addressed. If a minuscule 1-2 pixel variance is sufficient to induce a permanent, cascading identity swap, the algorithm is fundamentally brittle and unfit for rigorous biological analysis. This fragility manifests almost exclusively during trajectory crossings or physical collisions, where the spatial distance between fly A and fly B approaches zero.

### The Mathematical Flaw of Greedy Nearest-Neighbor Matching

In a naive nearest-neighbor tracker, the algorithm typically computes the Euclidean distance between the centroids of the targets established in frame $t-1$ and the new centroids detected in frame $t$. It then assigns identities based on a "greedy" heuristic approach—locating the absolute minimum distance in the cost matrix first, locking that assignment, and subsequently assigning the remaining identities sequentially.

Consider a scenario where Fly A is 15.0 pixels away from Detection 1 and 15.1 pixels away from Detection 2. A 1-pixel decoding error generated by integer rounding on a Linux machine could easily shift these centroid distances to 15.2 and 14.9, respectively. The greedy algorithm, observing the new minimum, will inadvertently swap the identities. Furthermore, because classical algorithms maintain no memory of morphology, once the identities are swapped, the tracker maintains the erroneous identity until the end of the video, leading to the massive, unrecoverable RMSE accumulation frequently observed by researchers.

### Transitioning to Global Bipartite Graph Optimization

The first vital mathematical modification to stabilize the tracker is to replace greedy heuristic matching with global bipartite graph optimization. This is formally defined as the Linear Sum Assignment Problem (LSAP).

The objective of LSAP is to find an assignment matrix $X$ that minimizes the total aggregate cost across all tracking targets simultaneously, rather than optimizing sequentially:

$$\min \sum_i \sum_j C_{i,j} X_{i,j}$$

Subject to the constraint that each row is assigned to exactly one column, and each column to exactly one row.

By utilizing the Hungarian Algorithm (also known as the Kuhn-Munkres algorithm), implemented in Python via `scipy.optimize.linear_sum_assignment`, the system evaluates the holistic optimal pairing. If matching Fly A to Detection 1 results in a slightly lower immediate cost, but forces Fly B into an extraordinarily distant, highly penalized match with Detection 2, the global optimization will reassign Fly A to Detection 2 to prevent the systemic penalty across the bipartite graph.

While the SciPy implementation is robust, researchers must be aware of edge cases. In certain scenarios, implementing assignment constraints using absolute mathematical infinity (`np.inf`) within the cost matrix can trigger an infinite loop bug in the SciPy solver, causing the script to hang indefinitely. This is circumvented by replacing infinite constraints with extraordinarily large finite numbers. Additionally, for highly dense tracking arenas where execution speed is paramount, alternative solvers utilizing the Jonker-Volgenant algorithm, such as the `lapjv` package or Rust-compiled libraries like `fastlap`, offer time complexity improvements from $O(n^3)$ to empirical $O(n^2)$ performance, vastly accelerating real-time tracking pipelines.

| LSAP Algorithm | Python Implementation | Characteristics and Limitations |
| :--- | :--- | :--- |
| **Hungarian Method** | `scipy.optimize.linear_sum_assignment` | Standard library support, highly stable. Susceptible to hanging on `np.inf` cost inputs. |
| **Jonker-Volgenant** | `lap.lapjv` | High performance, preferred for large matrices. Requires external C++ compilation. |
| **LAPJV (Rust)** | `fastlap` | State-of-the-art speed for large cohorts. Minimal code footprint, requires Rust toolchain. |

However, when two flies physically collide and occlude one another, even global spatial optimization cannot resolve the ambiguity, as the physical coordinates are virtually identical. Solving this requires advanced tracking models.

### Advanced State Estimation Context

In the broader context of multi-object biological tracking, researchers often implement complex state estimation algorithms to overcome these collisions. The Joint Probabilistic Data Association (JPDA) filter, and its derivatives like the Set JPDA (SJPDA), excel at maintaining Gaussian approximations of targets during occlusion. Interacting Multiple Model (IMM) filters dynamically switch between different mathematical models of movement depending on whether the fly is walking, jumping, or stopped.

For dealing specifically with deformable bodies like Drosophila, cutting-edge solutions utilize Active Contour Models (snakes) that map the elastic boundary of the fly through time, applying repulsive interaction forces to prevent the contours from merging during a collision. More recently, Active Shape Models (ASM) have been paired with Random Walker-based pre-segmentations to learn a low-dimensional posture space, successfully resolving identity even when larvae contours overlap completely.

While highly accurate, these advanced models are computationally exorbitant and highly complex to implement. A researcher seeking a "simple, lightweight" modification to standard nearest-neighbor logic requires an alternative approach that bridges the gap between static distance measurement and advanced state estimation.

---

## Part IV: Implementing Robust Kinematic Assignment Logic

To render the assignment logic mathematically immune to 1-2 pixel noise during a close crossing without deploying computationally heavy probabilistic filters, the cost matrix must be augmented to incorporate temporal kinematics. Specifically, the tracker must transition from measuring static centroid distances to applying a Constant Velocity (CV) predictive model.

### The Mechanics of the Constant Velocity (CV) Prediction

When two Drosophila cross paths, their spatial coordinates momentarily overlap, but their momentum (velocity vectors) generally point in opposing directions. By leveraging this historical momentum, the algorithm can predict the theoretical spatial coordinates where the flies should be located in the current frame $t$. Instead of populating the cost matrix $C$ with the distance between the old location and the new detection, the tracker computes the distance between the predicted location and the new detection.

A full Kalman Filter achieves this by maintaining complex covariance matrices for state transitions and measurement noise, dynamically updating the Kalman gain to weight predictions against noisy detections. However, a highly effective, lightweight modification achieves similar robustness by manually projecting the centroid based on immediate past velocity.

Let the state of a fly at time $t$ be its 2D position vector $\mathbf{p}_t = [x_t, y_t]$.
The instantaneous velocity vector at time $t-1$ is calculated as the displacement over the previous frame interval:

$$\mathbf{v}_{t-1} = \mathbf{p}_{t-1} - \mathbf{p}_{t-2}$$

The predicted position $\mathbf{\hat{p}}_t$ for the current frame assumes constant velocity (no sudden acceleration or sharp turning):

$$\mathbf{\hat{p}}_t = \mathbf{p}_{t-1} + \mathbf{v}_{t-1}$$

The cost matrix $C$ for the Hungarian algorithm is then formulated not on the static distance, but on the predictive residual—the distance from the kinematic prediction to the actual measured detection $\mathbf{d}_j$:

$$C_{i,j} = \left\| \mathbf{\hat{p}}_{i,t} - \mathbf{d}_{j,t} \right\|^2$$

### The Immunity Mechanism Against Pixel Decoding Noise

To understand how this kinematic projection provides absolute immunity to platform-dependent decoding variance, consider the scenario of a high-speed, head-on crossing between Fly A and Fly B where a 2-pixel decoding error occurs on a Linux machine:

- Fly A is moving steadily to the Right with a velocity vector of $[+10, 0]$ pixels per frame.
- Fly B is moving steadily to the Left with a velocity vector of $[-10, 0]$ pixels per frame.
- At frame $t-1$, both flies are precisely at the crossing point $x=100$.
- At frame $t$, Fly A's predicted position based on CV is $100 + 10 = 110$.
- At frame $t$, Fly B's predicted position based on CV is $100 - 10 = 90$.

On the Windows machine, the flies are correctly detected at $x=110$ and $x=90$. On the Linux machine, due to libswscale SIMD rounding differences, decoding noise perturbs the binarized edge, shifting the detected centroids to $x=108$ and $x=92$.

If a static nearest-neighbor algorithm was used, both flies were at $100$ in the previous frame. The distance to both new detections ($108$ and $92$) is roughly $8$ pixels. A sub-pixel error here creates ambiguity, and the greedy algorithm might swap them.

However, utilizing the CV prediction model, the separation between the predicted states ($110$ and $90$) is $20$ pixels. This massive predictive separation vastly overshadows the 2-pixel decoding noise. The cost matrix will heavily penalize assigning Fly A (predicted at $110$) to the erroneous detection at $x=92$, because the squared cost is $(110 - 92)^2 = 324$. Conversely, the correct assignment yields a squared cost of $(110 - 108)^2 = 4$. The Hungarian algorithm effortlessly assigns the correct identities despite the platform-specific decoding noise, preventing the cascade swap.

### Augmenting with Cosine Similarity for Directional Inertia

To further fortify the assignment without introducing the matrix inversions required by Kalman filters, a directional penalty can be introduced into the cost matrix. Biological motion is highly constrained by physics; Drosophila generally exhibit continuous forward locomotion paths, displaying a specific heading direction, rather than instantaneous, physics-defying 180-degree reversals between consecutive frames.

By computing the cosine similarity between the historical velocity vector $\mathbf{v}_{t-1}$ and the newly proposed displacement vector $\mathbf{v}_{proposed} = \mathbf{d}_{j,t} - \mathbf{p}_{i,t-1}$, the tracker severely penalizes assignments that require biologically implausible directional shifts. The use of heading direction increases system efficiency precisely when dealing with identity loss and fly swapping situations.

The final, highly robust cost matrix is defined as a weighted sum of spatial and directional terms:

$$C_{i,j} = \alpha \left\| \mathbf{p}_{i,t-1} - \mathbf{d}_{j,t} \right\| + \beta \left( 1 - \frac{\mathbf{v}_{i,t-1} \cdot \mathbf{v}_{proposed}}{\|\mathbf{v}_{i,t-1}\| \|\mathbf{v}_{proposed}\|} \right)$$

Where:
- $\alpha$ scales the standard Euclidean spatial distance.
- $\beta$ acts as a massive penalty for sudden changes in heading.

An identity swap during a crossing effectively manifests to the tracker as a sudden 180-degree reversal for both flies (as Fly A suddenly assumes Fly B's trajectory going in the opposite direction). A swap would result in a cosine similarity approaching $-1$, maximizing the penalty term to $2\beta$. This mathematical penalty absolutely prevents the global LSAP solver from selecting the swapped assignment, regardless of any sub-pixel spatial perturbations introduced by cross-platform video decoding artifacts. This modification requires only standard vector arithmetic utilizing numpy, completely sidestepping the overhead of heavy tracking libraries while providing robust immunity to the described failure modes.

---

## Conclusions on Cross-Platform Tracking Methodologies

The permanent identity swaps observed between Windows and Google Colab environments in Drosophila multi-object tracking are the consequence of a highly fragile static tracking algorithm interacting with non-deterministic video decoding abstraction layers. The macroscopic tracking divergences, resulting in RMSE exceeding 75 pixels, are triggered by sub-pixel and 1-2 pixel coordinate discrepancies. These discrepancies are unavoidable artifacts of hardware acceleration divergence (CUDA vs. QSV vs. CPU) and libswscale integer rounding approximations across different CPU SIMD microarchitectures when converting compressed YUV 4:2:0 video into planar BGR matrices.

To achieve 100% bit-exact parity and eliminate the environmental triggers of this failure, practitioners must aggressively strip away abstraction layers. This is accomplished either by forcing the OpenCV VideoCapture module to utilize the software CPU FFmpeg decoder equipped with strict bitexact, accurate_rnd, and full_chroma_int environment flags; by piping raw byte streams directly into Numpy arrays via FFmpeg subprocess wrappers like ffmpeg-python; or by standardizing the experimental workflow by pre-decoding all videos into mathematically lossless formats like libx264rgb prior to processing.

Concurrently, classical static nearest-neighbor logic is insufficiently robust for biological tracking, particularly during occlusions and collisions. By substituting greedy heuristic matching with a global bipartite graph optimization solver like the Hungarian algorithm (scipy.optimize.linear_sum_assignment), and fundamentally shifting the distance cost matrix from static centroids to a kinematic Constant Velocity (CV) prediction enhanced by directional cosine similarity, the tracker gains vital inertia. This predictive momentum ensures that when subjects cross paths, their distinct velocity vectors and headings decisively disambiguate their identities. Integrating these decoding standards and kinematic modifications renders the tracking pipeline wholly immune to the sub-pixel noise inherent in cross-platform video decoding, ensuring the biological validity of the resulting locomotion data across all operating systems.
