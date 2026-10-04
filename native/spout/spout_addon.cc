// Minimal Spout sender addon (Windows only), the Windows counterpart of
// node-syphon's SyphonMetalServer as used by src/syphon.ts.
//
// Wraps the Spout2 SDK's SpoutDX class (vendor/spout2): SendImage() uploads a
// CPU pixel buffer into a shared DX11 texture that any Spout receiver can open.
// Plain Node-API (C), so the built .node is ABI-stable across Node/Electron.
//
// JS surface:
//   createSender(name: string): object       // opaque handle
//   sendImage(sender, rgba: Uint8Array, width: number, height: number): boolean
//   releaseSender(sender): void              // idempotent
//
// Pixels are RGBA, top-left origin (DX textures are top-down, same as
// Electron's bitmaps, so unlike Syphon no vertical flip is needed).

#define NAPI_VERSION 8
#include <node_api.h>

#include <string>

#include "SpoutDX.h"

namespace {

struct Sender {
  spoutDX* dx = nullptr;
};

void DestroySender(Sender* s) {
  if (!s->dx) return;
  s->dx->ReleaseSender();
  s->dx->CloseDirectX11();
  delete s->dx;
  s->dx = nullptr;
}

void FinalizeSender(napi_env, void* data, void*) {
  Sender* s = static_cast<Sender*>(data);
  DestroySender(s);
  delete s;
}

napi_value Throw(napi_env env, const char* msg) {
  napi_throw_error(env, nullptr, msg);
  return nullptr;
}

Sender* GetSender(napi_env env, napi_value value) {
  void* data = nullptr;
  if (napi_get_value_external(env, value, &data) != napi_ok) return nullptr;
  return static_cast<Sender*>(data);
}

napi_value CreateSender(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc < 1) return Throw(env, "createSender(name) requires a name");

  size_t len = 0;
  if (napi_get_value_string_utf8(env, argv[0], nullptr, 0, &len) != napi_ok) {
    return Throw(env, "createSender: name must be a string");
  }
  std::string name(len, '\0');
  napi_get_value_string_utf8(env, argv[0], &name[0], len + 1, &len);

  spoutDX* dx = new spoutDX();
  if (!dx->OpenDirectX11()) {
    delete dx;
    return Throw(env, "Spout: failed to open a DirectX 11 device");
  }
  dx->SetSenderName(name.c_str());
  // Our frames are RGBA; SpoutDX defaults to BGRA.
  dx->SetSenderFormat(DXGI_FORMAT_R8G8B8A8_UNORM);

  Sender* s = new Sender();
  s->dx = dx;
  napi_value result;
  if (napi_create_external(env, s, FinalizeSender, nullptr, &result) != napi_ok) {
    DestroySender(s);
    delete s;
    return Throw(env, "createSender: failed to create handle");
  }
  return result;
}

napi_value SendImage(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc < 4) {
    return Throw(env, "sendImage(sender, rgba, width, height) requires 4 args");
  }

  Sender* s = GetSender(env, argv[0]);
  if (!s) return Throw(env, "sendImage: invalid sender handle");

  bool isTyped = false;
  napi_is_typedarray(env, argv[1], &isTyped);
  if (!isTyped) return Throw(env, "sendImage: pixels must be a Uint8Array");
  napi_typedarray_type type;
  size_t length = 0;
  void* data = nullptr;
  // `data` already accounts for the view's byteOffset.
  napi_get_typedarray_info(env, argv[1], &type, &length, &data, nullptr, nullptr);
  if (type != napi_uint8_array && type != napi_uint8_clamped_array) {
    return Throw(env, "sendImage: pixels must be a Uint8Array");
  }

  uint32_t width = 0, height = 0;
  napi_get_value_uint32(env, argv[2], &width);
  napi_get_value_uint32(env, argv[3], &height);
  if (width == 0 || height == 0) return Throw(env, "sendImage: bad size");
  if (length < static_cast<size_t>(width) * height * 4) {
    return Throw(env, "sendImage: pixel buffer smaller than width*height*4");
  }

  bool ok = false;
  if (s->dx) {
    ok = s->dx->SendImage(static_cast<const unsigned char*>(data), width, height);
  }
  napi_value result;
  napi_get_boolean(env, ok, &result);
  return result;
}

napi_value ReleaseSender(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc >= 1) {
    Sender* s = GetSender(env, argv[0]);
    if (s) DestroySender(s);
  }
  return nullptr;
}

napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor props[] = {
      {"createSender", nullptr, CreateSender, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"sendImage", nullptr, SendImage, nullptr, nullptr, nullptr, napi_default,
       nullptr},
      {"releaseSender", nullptr, ReleaseSender, nullptr, nullptr, nullptr,
       napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(props) / sizeof(props[0]), props);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
