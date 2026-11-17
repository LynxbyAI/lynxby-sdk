from lynxby import Lynxby

lynx = Lynxby()
run = lynx.tasks.run(8, {"text": "A long letter."})
print(run["answer"])
