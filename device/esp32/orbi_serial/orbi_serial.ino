#include <Arduino.h>
#include <string.h>

namespace {
constexpr size_t commandCapacity = 64;
char command[commandCapacity];
size_t length = 0;
bool overflow = false;

void respond() {
  if (strcmp(command, "HELLO") == 0) {
    Serial.println("ORBI READY");
  } else if (strncmp(command, "PING ", 5) == 0 && length == 41) {
    Serial.print("PONG ");
    Serial.println(command + 5);
  }
}
}  // namespace

void setup() {
  Serial.begin(115200);
}

void loop() {
  while (Serial.available() > 0) {
    const char byte = static_cast<char>(Serial.read());
    if (byte == '\r') {
      continue;
    }
    if (byte == '\n') {
      if (!overflow) {
        command[length] = '\0';
        respond();
      }
      length = 0;
      overflow = false;
      continue;
    }
    if (length < commandCapacity - 1) {
      command[length++] = byte;
    } else {
      overflow = true;
    }
  }
}
