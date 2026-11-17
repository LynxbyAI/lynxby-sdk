import os

from lynxby import Lynxby

# LYNXBY_TOKEN and LYNXBY_BASE_URL come from the environment.
client = Lynxby()
assistant = int(os.environ.get("LYNXBY_ASSISTANT_ID", "1"))

# Closing the iterator, or Ctrl+C, closes the request instead of leaving the
# turn running.
stream = client.agents.stream(assistant, "Summarise the contract.")

try:
    for event in stream:
        if event["event"] == "delta":
            print(event["data"]["delta"], end="", flush=True)
        elif event["event"] == "error":
            print(f"\n{event['data']['code']}: {event['data']['message']}")
        elif event["event"] == "done":
            print(f"\n\n{event['data']['content']}")
            print(f"model: {event['data']['model']}, cost: {event['data']['cost']} {event['data']['currency']}")
finally:
    stream.close()
