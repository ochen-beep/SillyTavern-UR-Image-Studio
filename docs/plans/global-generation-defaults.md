# Generation defaults

UR Image Studio keeps generation defaults per chat by default. A future global-defaults option should allow one set of model, aspect ratio, image size, and quality values to act as fallbacks for every chat.

Precedence:

1. When disabled, only the current chat's values are used.
2. When enabled, a non-null global value is used when the current chat value is null.
3. An explicit non-null chat value always wins.
4. `null` means unset; it must not be confused with a provider's default value.

Enabling the option must not rewrite every chat's metadata. The Generate tab should show whether each effective value comes from the chat or the global defaults. A global model must be validated against the active connection/catalog before dispatch.

The first implementation should use the existing SillyTavern extension settings drawer rather than adding another floating-window tab. It needs a strict boolean toggle, four nullable global values, and an action to copy the current chat's effective values to the global set. Tests must cover chat overrides, unset values, chat switching, disabling the option, persistence, and an unavailable global model.
