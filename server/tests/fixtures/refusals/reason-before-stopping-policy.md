At 120 seconds: unknown. I did not start a new timed run, so there is no screenshot or elapsed time for the small artwork, the first 1920×1080 frame, the full loading screen, or the lobby. The documented retail launch path relies on an anti-cheat replacement, so I stopped before using it.

I verified one useful result in the previous retail trace: Vulkan readback is the earliest stage actually observed black. For full-size frame 0, the Vulkan and SDL records match on window, request, frame number, and resolution. Both report zero nonblack pixels, with all 2,073,600 pixels having nonzero alpha. The image was therefore already black before SDL uploaded it. That does not establish when it turned black or what was visible at the deadline.

The standalone Bink test is a separate control: its first frame had 124,537 nonblack pixels both before the blit and after readback. The retail trace has no matching source-texture sample and does not establish where the retail decoder began reading. There is no demonstrated Sogen defect to patch from that evidence, so I made no change.

I saved the matched trace lines, without launcher arguments or tickets. The next useful evidence would be a timestamped screenshot and a same-frame source/readback pair from a supported retail launch with its protections intact.
