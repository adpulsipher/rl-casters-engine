#!/usr/bin/env bash
# RL Career Casters cloud studio: one-time setup on a fresh GPU pod (about 10 minutes).
# Installs ffmpeg, tmux, and a Python environment in /workspace/venv with vLLM + vLLM-Omni
# (the server that runs Fish Audio Drama 3) and the line checker.
set -euo pipefail
cd "$(dirname "$0")"

export HF_HOME=/workspace/hf
mkdir -p /workspace/hf

echo "== system tools"
if command -v apt-get >/dev/null; then
  apt-get update -qq && apt-get install -y -qq ffmpeg tmux git >/dev/null
fi

echo "== Python environment (/workspace/venv)"
python3 -m pip install -q -U uv
# the environment lives on the pod's local disk (much faster than /workspace); /workspace/venv points to it
if [ ! -x /opt/venv/bin/python ]; then
  uv venv /opt/venv --python 3.12 --seed
fi
ln -sfn /opt/venv /workspace/venv
# shellcheck disable=SC1091
source /workspace/venv/bin/activate

echo "== vLLM and vLLM-Omni (Drama 3 support)"
# Pinned: vLLM-Omni 0.34 dropped Drama 3 (its codec stage needs the retired Model Runner V1).
# 0.32.0 of both is the last release pair that serves it.
export UV_CACHE_DIR=/root/.cache/uv UV_LINK_MODE=copy   # local disk: /workspace is slow for builds
uv pip install "vllm==0.32.0" --torch-backend auto
rm -rf /root/src/omni-v0.32.0
git clone -q --depth 1 --branch v0.32.0 https://github.com/vllm-project/vllm-omni.git /root/src/omni-v0.32.0
VLLM_OMNI_TARGET_DEVICE=cuda uv pip install /root/src/omni-v0.32.0
# Leave GPU memory for the codec stage and the line checker (the default 0.78 was tuned on a 141 GB H200).
sed -i '0,/gpu_memory_utilization: 0.78/s//gpu_memory_utilization: 0.68/' "$(python -c 'import vllm_omni,os;print(os.path.dirname(vllm_omni.__file__))')/deploy/fish_omni.yaml"

echo "== line checker and audio tools"
uv pip install soundfile scipy requests transformers faster-whisper

grep -q 'HF_HOME=/workspace/hf' ~/.bashrc 2>/dev/null || echo 'export HF_HOME=/workspace/hf' >> ~/.bashrc

echo
echo "Setup done. In every new terminal, first run:"
echo "  source /workspace/venv/bin/activate"
echo "Then: python studio_cloud.py count"
