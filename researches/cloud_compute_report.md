# High-Throughput Video Tracking Infrastructure: A Technical and Financial Evaluation of Cloud Compute Alternatives to Google Colab

This report evaluates alternative cloud compute infrastructures to replace Google Colab for running the "Flyt" Drosophila melanogaster behavioral tracking pipeline.

## Technical Evaluation of Alternative Cloud Compute Platforms

### Modal: High-Performance Python-Native Serverless Runtime
Modal represents a specialized serverless compute platform that abstracts the underlying virtualized hardware by declaring the container environment, system packages, and hardware resources directly in standard Python code.

*   **Cold-Start Latency**: Modal achieves container cold starts of approximately 1 second through a heavily optimized virtual file system and a custom Rust-based container orchestration stack. Rather than pulling complete container images from a registry, Modal utilizes a content-addressed FUSE filesystem that demand-loads only the necessary packages and binary dependencies during startup.
*   **Storage & Data Transfer**: File synchronization is managed natively through the `modal.Volume` API, which is engineered to supply up to 2.5 GB/s of read/write file bandwidth. Videos are uploaded from local host environments to a remote volume via parallelized, chunked batch uploads using the Python client SDK. Once uploaded, files are mounted directly into the runtime filesystem. Crucially, Modal does not assess data ingress or egress fees on standard workloads, which represents a significant competitive advantage when transferring hundreds of gigabytes of video data monthly.
*   **CPU-Only Friendliness**: Modal allocates standard CPU compute resources dynamically, charging $0.0470 per physical core-hour and $0.0080 per GiB-hour. Because Modal physical cores map to 2 vCPUs, execution environments can scale with high granularity down to 0.125 cores per container. Sandboxed execution, isolated via Google’s gVisor runtime for security-sensitive or untrusted code runs, is priced at $0.1419 per physical core-hour and $0.0242 per GiB-hour.
*   **Scale & Concurrency**: The platform scales from zero to 50,000 parallel container sessions instantly. This enables the Flyt pipeline to launch 10 to 20 tracking runs concurrently in response to large physical assay batches, without queueing delays or resource throttling.
*   **Configuration & Automation**: Operational complexity is exceptionally low. Complete environments are declared in Python files, completely eliminating the need to write Dockerfiles, compile custom base images, or maintain YAML configurations.
*   **Free Tier**: Includes $30/month of free tier credits (Starter plan) and 1 TiB of free Volume storage. At $0.0470 per core-hour, this provides ~638 core-hours of CPU compute monthly for free.

---

### Google Cloud Run and AWS Fargate: Serverless Container Platforms
Serverless container runners isolate execution within micro-virtual machines, scaling infrastructure dynamically in response to web requests or programmatic triggers.

*   **Google Cloud Run**: Operating in Tier 1 regions, Cloud Run services scale to zero and charge $0.0864 per vCPU-hour and $0.0090 per GiB-hour of active execution. Google provides an always-free monthly tier of 180,000 vCPU-seconds and 360,000 GiB-seconds. While container startup times are low (ranging from 1 to 5 seconds under Gen1 gVisor isolation), standard Cloud Run HTTP/1 services impose a strict 32MB payload limit on inbound requests. Uploading video files up to 1GB over HTTP/1 triggers a "413: Request Entity Too Large" error, which requires implementing complex chunking upload logic or pre-staging videos in a Google Cloud Storage bucket using IAM-signed URLs. To resolve these limitations, the Flyt pipeline must utilize Cloud Run Jobs, which are specifically designed for run-to-completion tasks and support execution durations of up to 24 hours without web server timeouts.
*   **AWS Fargate**: Running on Amazon ECS, AWS Fargate executes containers inside dedicated Firecracker micro-VMs. Standard compute is priced at $0.04048 per vCPU-hour and $0.004445 per GB-hour for Linux/x86. ARM-based architecture utilizing AWS Graviton processors is priced at $0.03238 per vCPU-hour, yielding a 20% cost reduction. Spot instances are highly cost-effective, providing up to 70% off the standard price to lower compute costs to approximately $0.0124 per vCPU-hour. However, container cold starts on AWS Fargate are slow, typically requiring 30 to 60 seconds to pull container images from ECR and initialize resources. Furthermore, a secure, private Fargate deployment requires permanent payment for an Application Load Balancer ($22.27/month) and NAT Gateways ($65.70/month per VPC in a highly available multi-AZ setup) to handle network traffic. These persistent fixed charges eliminate Fargate's cost-efficiency for bursty, low-volume video tracking runs.

---

### GCP Batch and AWS Batch: Queue-Based Schedulers
Managed batch engines are engineered to schedule, queue, and orchestrate large volumes of containerized tasks across dynamic clusters of virtual instances.

*   **GCP Batch**: Google Cloud Batch provides a fully managed orchestration service for running sequential and parallel job arrays. While GCP Batch reduces infrastructure overhead by dynamically provisioning Compute Engine VMs, the platform introduces significant scheduling latency. Submitted jobs enter a QUEUED and SCHEDULED state while GCP Batch checks regional quotas and provisions instances. Standard scheduling latency ranges from seconds to several minutes, but can stretch to hours during periods of high regional demand or when hitting regional SSD disk storage quotas.
*   **AWS Batch**: This service places submitted tasks into a priority queue and schedules them to run on EC2, Spot, or Fargate compute environments. Although Fargate-backed environments can start jobs in under 30 seconds, the scheduling overhead of AWS Batch is highly inefficient for short tracking runs. AWS Batch operates as a throughput scheduler rather than an instant container runner, optimizing for bin-packing density and cost-efficiency. For short tasks lasting only a few minutes, the queuing delay and orchestration overhead often exceed the actual tracking execution time. To mitigate this, AWS Batch best practices recommend grouping and bin-packing multiple tracking tasks into fewer, longer-running job sessions (ideally 3 to 5 minutes each), which complicates real-time automation.

---

### RunPod Serverless and Vast.ai: Marketplace and GPU-Focused Runtimes

*   **RunPod Serverless CPU**: RunPod’s serverless platform uses its "Flash" framework to execute containerized functions on demand. CPU-only workloads are executed on standardized virtual machine classes, such as cpu5c-4-8 (4 vCPUs, 8GB RAM). RunPod charges per second of active execution, with no fees for data ingress or egress. To achieve low-latency execution, RunPod utilizes pre-warmed container pools. However, under true scale-to-zero configurations (workersMin=0), initial container cold starts still range from 20 to 90 seconds. To eliminate this cold-start delay, the pipeline must keep at least one container warm (workersMin=1). This warm-pool configuration incurs persistent idle costs, charging the team even when no videos are actively being tracked.
*   **Vast.ai**: Vast.ai operates as a decentralized marketplace where users rent bare-metal compute instances directly from independent hosts globally. While the dynamic marketplace model offers cheap compute rates—often under $0.02 per CPU core-hour—Vast.ai does not support serverless scale-to-zero operations. Storage charges begin immediately upon container provisioning and continue to accrue even when instances are stopped. Additionally, because container image pulling depends on the host's regional network connection, cold starts can exceed 5 minutes. The lack of platform SLAs, combined with variable host network speeds and hardware reliability, makes Vast.ai highly unsuitable for automated, production-grade tracking assays.

---

### GitHub Actions: CI/CD Infrastructure Abuse Analysis

*   **Technical Feasibility**: GitHub-hosted Linux runners provide a default virtual hardware profile consisting of a 2-core x64 CPU with 8GB of RAM and 10GB of cache storage. Workflows can leverage matrix builds to run up to 256 parallel tracking sessions. Beyond the default monthly free allowance, standard Linux runner minutes are billed at $0.0060 per minute ($0.3600 per hour). Self-hosted runners on private repositories are also billed, costing $0.0020 per minute ($0.1200 per hour) since March 2026.
*   **Acceptable Use Policy Constraints**: Utilizing GitHub-hosted runners to execute continuous, non-CI/CD data-processing workloads (such as video rendering, automated scientific modeling, or behavioral tracking) violates GitHub's Acceptable Use Policies and Terms of Service. GitHub's automated security systems actively scan for non-CI/CD execution patterns. These systems detect anomalies using process signature monitoring (scanning for long-running tracking loops or specific binary footprints), network traffic analysis (detecting long-lived, high-bandwidth outbound transfers that differ from dependency pulling), and execution duration patterns (flagging scripts designed to keep runners alive close to the 6-hour timeout limit). Violating these policies triggers automated heuristics that freeze the workflow and can result in the immediate termination of the associated user or organization account.

---

## Comparative Platform Analysis

The following table provides a comprehensive quantitative and qualitative comparison of the cloud compute alternatives evaluated for the Flyt tracking pipeline.

| Cloud Platform | Provisioning / Cold-Start Latency | Cost per CPU-Core Hour (USD) | Storage & Data Transfer Capabilities | Automation Complexity (Lines of CLI/Config) |
|---|---|---|---|---|
| **Modal** | **1.0 – 2.0 seconds** | **$0.0470** | **High-speed volume mount (up to 2.5 GB/s); no ingress or egress charges** | **~5 lines of Python decorator code** |
| Google Cloud Run Jobs | 3.0 – 8.0 seconds | $0.0864 | Integrated with GCS buckets; egress billed at $0.12/GB | ~15 lines of gcloud CLI or YAML |
| AWS Fargate | 30.0 – 60.0 seconds | $0.0405 (On-Demand) / $0.0124 (Spot) | Integrated with S3 buckets; egress billed at $0.09/GB | ~45 lines of ECS JSON Task definitions |
| AWS / GCP Batch | 30.0 – 300.0+ seconds | $0.0405 (AWS Fargate-backed) | Direct bucket integration; high queuing delay | ~30 lines of Job Queue & Definition JSON |
| RunPod Serverless | 20.0 – 90.0 seconds (scale-to-zero) | $0.0167 (equivalent Northflank CPU rate) | Local persistent storage; no egress charges assessed | ~12 lines of RunPod Flash Python/YAML |
| Vast.ai | 120.0 – 300.0 seconds | ~$0.005 – $0.020 (dynamic marketplace) | Local disk copying; persistent storage fees when stopped | ~20 lines of vastai CLI and search scripts |
| GitHub Actions | 10.0 – 30.0 seconds | $0.1800 (pro-rated standard Linux core-hour) | Restricted standard cache storage | ~25 lines of GitHub Actions workflow YAML |

---

## Actionable Recommendations & Tiered Architecture

1.  **Modal (Rank 1)**: Identified as the optimal architecture for the Flyt assay. It combines sub-2-second cold-start latency, native Python orchestration, high-speed file synchronization via dedicated volumes, and a pure pay-per-second billing model with zero data egress charges. It includes a free tier of $30/month in credits (~638 core-hours/month free).
2.  **Google Cloud Run Jobs (Rank 2)**: Best for organizations requiring strict deployment on a major cloud provider. It provides scale-to-zero isolation and secure IAM role integration, but requires using Cloud Storage bucket staging to bypass the 32MB payload limit.
3.  **RunPod Serverless CPU via Flash SDK (Rank 3)**: Offers cheap per-second active billing and is highly performant. However, it is ranked third due to high scale-to-zero cold starts (up to 90 seconds), which require keeping warm workers active and incurring persistent idle fees.

---

## Architectural Code Skeletal Blueprint (Modal App example)

```python
import os
from pathlib import Path
import modal

# Define a standard, minimal container runtime environment
flyt_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install(
        [
            "libgl1-mesa-glx",  # Essential for OpenCV graphics bindings
            "libglib2.0-0",     # Required for glib process interactions
            "ffmpeg"            # Essential for video decoding and frames extraction
        ]
    )
    .pip_install(
        [
            "opencv-python-headless>=4.10.0",
            "pandas>=2.0.0",
            "numpy<2.0.0"
        ]
    )
)

# Initialize the Modal App namespace
app = modal.App(name="flyt-assay-processing")

# Instantiate a persistent remote storage volume
flyt_volume = modal.Volume.from_name("flyt-assay-store", create_if_missing=True)

@app.function(
    image=flyt_image,
    volumes={"/mnt/assays": flyt_volume},
    cpu=4.0,           # Allocates 4 dedicated, high-performance CPU cores
    memory=8192,       # Allocates 8 GB of RAM to handle video decoding
    timeout=1200       # Imposes a strict 20-minute timeout limit per task
)
def execute_opencv_tracker(video_filename: str) -> str:
    import cv2
    import numpy as np
    import pandas as pd

    video_path = f"/mnt/assays/videos/{video_filename}"
    output_filename = f"{Path(video_filename).stem}_coordinates.csv"
    output_path = f"/mnt/assays/results/{output_filename}"

    if not os.path.exists(video_path):
        raise FileNotFoundError(f"Target video file not found: {video_path}")

    # Establish video capture stream
    capture = cv2.VideoCapture(video_path)
    
    # Instantiate Mixture of Gaussians background subtractor
    bg_subtractor = cv2.createBackgroundSubtractorMOG2(
        history=500, 
        varThreshold=16, 
        detectShadows=False
    )
    
    coordinate_records = []
    frame_id = 0

    while capture.isOpened():
        ret, frame = capture.read()
        if not ret:
            break

        # Generate binary foreground segmentation mask
        foreground_mask = bg_subtractor.apply(frame)
        
        # Isolate exterior contours
        contours, _ = cv2.findContours(
            foreground_mask, 
            cv2.RETR_EXTERNAL, 
            cv2.CHAIN_APPROX_SIMPLE
        )
        
        for contour in contours:
            area = cv2.contourArea(contour)
            if 5.0 < area < 150.0:  # Spatial filter constraints for Drosophila
                moments = cv2.moments(contour)
                if moments["m00"] != 0.0:
                    center_x = int(moments["m10"] / moments["m00"])
                    center_y = int(moments["m01"] / moments["m00"])
                    coordinate_records.append({
                        "frame": frame_id,
                        "x": center_x,
                        "y": center_y,
                        "size": area
                    })
        
        frame_id += 1

    capture.release()

    # Structure extracted spatial tracking data into Pandas DataFrame
    df = pd.DataFrame(coordinate_records)
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    df.to_csv(output_path, index=False)

    # Flush file writes and commit changes to ensure persistence across sessions
    flyt_volume.commit()
    
    return output_filename
```
