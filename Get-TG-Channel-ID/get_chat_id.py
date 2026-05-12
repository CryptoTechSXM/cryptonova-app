import requests
import time

BOT_TOKEN = "7716066914:AAEZATUSQXRRsTIO3xCIrYpNJ8dwzEnF1Iw"

URL = f"https://api.telegram.org/bot{BOT_TOKEN}/getUpdates"

print("Listening for messages... Send a message in your group/channel.\n")

last_update_id = None

while True:
    response = requests.get(URL).json()

    if not response["ok"]:
        print("Error:", response)
        time.sleep(2)
        continue

    for update in response["result"]:
        update_id = update["update_id"]

        if last_update_id is not None and update_id <= last_update_id:
            continue

        last_update_id = update_id

        if "message" in update:
            chat = update["message"]["chat"]
        elif "channel_post" in update:
            chat = update["channel_post"]["chat"]
        else:
            continue

        print("===================================")
        print(f"Chat Title : {chat.get('title', 'Private Chat')}")
        print(f"Chat ID    : {chat['id']}")
        print(f"Chat Type  : {chat['type']}")
        print("===================================\n")

    time.sleep(2)