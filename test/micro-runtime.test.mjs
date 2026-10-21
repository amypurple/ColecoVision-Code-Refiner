import test from "node:test";
import assert from "node:assert/strict";
import { recognizeStaticMode2Text, synthesizeStaticMode2Text, recognizeControllerBorderDemo } from "../src/micro-runtime.mjs";

const hello = `
; CVBasic program start.
call mode_2
ld a,5
ld b,a
ld c,7
call nmi_off
call WRTVDP
call nmi_on
ld hl,330
ld (cursor),hl
ld hl,cv1
ld a,3
call print_string
jr cv2
cv1:
db $41,$42,$43
cv2:
cv3:
db $76+COLECO_SPINNER*$59
jp cv3
cv4:
; CVBasic epilogue
`;

test("recognizes the strict static MODE 2 text program", () => {
  const result = recognizeStaticMode2Text(hello);
  assert.equal(result.matched, true);
  assert.equal(result.border, 5);
  assert.equal(result.cursor, 330);
  assert.deepEqual(result.bytes, [0x41, 0x42, 0x43]);
});

test("synthesizes a readable OS7 micro-runtime", () => {
  const result = synthesizeStaticMode2Text(hello);
  assert.equal(result.matched, true);
  assert.match(result.text, /call MODE_1/);
  assert.match(result.text, /call LOAD_ASCII/);
  assert.match(result.text, /call WRITE_VRAM/);
  assert.match(result.text, /db \$41,\$42,\$43/);
  assert.doesNotMatch(result.text, /print_string:/i);
});

test("rejects extra behavior rather than deleting it", () => {
  const result = recognizeStaticMode2Text(hello.replace("jp cv3", "call update_controllers\njp cv3"));
  assert.equal(result.matched, false);
  assert.match(result.reason, /does more than wait/i);
});

test("recognizes the closed controller-border family", () => {
  const print = (cursor, label, bytes, after) => `ld hl,${cursor}\nld (cursor),hl\nld hl,${label}\nld a,${bytes.length}\ncall print_string\njr ${after}\n${label}:\ndb ${bytes.map((value) => `$${value.toString(16)}`).join(",")}\n${after}:`;
  const border = (value) => `ld a,${value}\nld b,a\nld c,7\ncall nmi_off\ncall WRTVDP\ncall nmi_on`;
  const source = `; CVBasic program start.\ncall mode_2\n${print(1, "s1", [65], "a1")}\n${print(2, "s2", [66], "a2")}\n${print(3, "s3", [67], "a3")}\nloop:\ndb $76+COLECO_SPINNER*$59\nld a,(key1_data)\ncp 15\n${border(13)}\nld a,(joy1_data)\nand 128\nld a,(joy1_data)\nand 64\n${border(9)}\nld a,(joy1_data)\nand 1\n${border(3)}\nld a,(joy1_data)\nand 4\n${border(12)}\nld a,(joy1_data)\nand 8\n${border(11)}\nld a,(joy1_data)\nand 2\n${border(7)}\n${border(4)}\njp loop\n; CVBasic epilogue`;
  const result = recognizeControllerBorderDemo(source);
  assert.equal(result.matched, true, result.reason);
  assert.equal(result.prints.length, 3);
});
