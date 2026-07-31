from setuptools import setup, find_packages

setup(
    name="moye-agent-sdk",
    version="0.1.0",
    description="Python SDK for MOYE Agent-to-Agent protocol network",
    license="MIT",
    packages=find_packages(),
    install_requires=["requests>=2.28.0"],
    python_requires=">=3.8",
)
