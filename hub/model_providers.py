"""Provider transport for managed credentials; keeps the gateway's accounting independent.

OpenAI-compatible providers use HTTP directly. Native Anthropic/Gemini/Bedrock calls use the
same LiteLLM version and provider prefixes as the desktop backend. LiteLLM is imported lazily
so the default DeepSeek-only Hub does not pay its startup/memory cost.
"""
import json
import httpx


class NativeStream(httpx.AsyncByteStream):
    def __init__(self, stream):
        self.stream = stream

    async def __aiter__(self):
        try:
            async for chunk in self.stream:
                payload = chunk.model_dump(mode="json") if hasattr(chunk, "model_dump") else chunk
                yield ("data: " + json.dumps(payload, ensure_ascii=False) + "\n\n").encode()
            yield b"data: [DONE]\n\n"
        except Exception as error:
            raise httpx.ReadError("Native model stream was interrupted.") from error

    async def aclose(self):
        close = getattr(self.stream, "aclose", None)
        if close:
            await close()


class NoopClient:
    async def aclose(self):
        pass


async def open_completion(credential: dict, payload: dict):
    provider = credential["provider"]
    if provider != "deepseek" and "deepseek" not in credential["model"].lower():
        payload = {**payload, "messages": [{key: value for key, value in message.items() if key != "reasoning_content"}
                                           for message in payload["messages"]]}
    if provider in {"openai", "openrouter", "deepseek"}:
        client = httpx.AsyncClient(timeout=httpx.Timeout(300, connect=15), follow_redirects=False)
        try:
            response = await client.send(client.build_request("POST", credential["base_url"] + "/chat/completions",
                headers={"Authorization": "Bearer " + credential["api_key"]}, json=payload), stream=True)
        except BaseException:
            await client.aclose()
            raise
        return response, client

    import litellm
    litellm.telemetry = False
    litellm.suppress_debug_info = True
    model = credential["model"] if "/" in credential["model"] else f"{provider}/{credential['model']}"
    kwargs = {**payload, "model": model, "api_key": credential["api_key"],
              "timeout": 300, "num_retries": 0}
    kwargs["messages"] = [{key: value for key, value in message.items() if key != "reasoning_content"}
                          for message in kwargs["messages"]]
    if credential["base_url"]:
        kwargs["api_base"] = credential["base_url"]
    if provider == "bedrock":
        # Same bearer-token convention as backend/llm.py.
        if kwargs["api_key"].startswith("AWS_BEARER_TOKEN_BEDROCK="):
            kwargs["api_key"] = kwargs["api_key"].split("=", 1)[-1].strip()
        kwargs["aws_region_name"] = credential.get("aws_region_name", "us-east-1")
    try:
        result = await litellm.acompletion(**kwargs)
    except Exception as error:
        if isinstance(error, (litellm.Timeout, litellm.APIConnectionError)):
            raise httpx.ReadError("Native model request was interrupted.") from error
        status = getattr(error, "status_code", None)
        if isinstance(status, int) and 400 <= status < 600:
            return httpx.Response(status, json={"error": {"message": str(error)}}), NoopClient()
        raise httpx.ReadError("Native model request was interrupted.") from error
    if payload.get("stream"):
        return httpx.Response(200, stream=NativeStream(result)), NoopClient()
    data = result.model_dump(mode="json") if hasattr(result, "model_dump") else result
    return httpx.Response(200, json=data), NoopClient()
