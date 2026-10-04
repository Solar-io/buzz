# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: sidebar-order.spec.ts >> rendered sidebar order >> Favorites: mixed channels and DMs use unread, four most used, then A-Z
- Location: tests/e2e/sidebar-order.spec.ts:261:3

# Error details

```
Error: expect(locator).toHaveText(expected) failed

Locator: getByTestId('channel-sidebar').locator('section[aria-label="Favorites"]').locator('ul > li > button[data-active] span.truncate')
Timeout: 5000ms
- Expected  - 1
+ Received  + 1

@@ -2,9 +2,9 @@
    "urgent-favorite",
    "Vera favorite",
    "Tango favorite",
    "Sierra favorite",
    "Romeo favorite",
+   "zebra favorite",
    "aardvark favorite",
    "Bravo favorite",
-   "zebra favorite",
  ]

Call log:
  - Expect "toHaveText" with timeout 5000ms
  - waiting for getByTestId('channel-sidebar').locator('section[aria-label="Favorites"]').locator('ul > li > button[data-active] span.truncate')
    14 × locator resolved to 8 elements

```

# Page snapshot

```yaml
- generic [ref=e2]:
  - main [ref=e4]:
    - generic [ref=e5]:
      - complementary [ref=e6]:
        - generic [ref=e7]:
          - generic [ref=e8]:
            - 'button "Buzz menu: settings, status and your account" [ref=e10] [cursor=pointer]':
              - generic [ref=e11]: B
              - generic [ref=e12]: Buzz
              - img [ref=e13]
            - generic [ref=e15]:
              - img [ref=e16]
              - textbox "Search messages" [ref=e19]:
                - /placeholder: Jump to…
              - generic [ref=e20]: ⌘K
            - generic [ref=e21]:
              - button "Inbox" [ref=e22] [cursor=pointer]:
                - img [ref=e23]
                - generic [ref=e26]: Inbox
              - button "Items" [ref=e27] [cursor=pointer]:
                - img [ref=e28]
                - generic [ref=e29]: Items
              - button "Shelf" [ref=e30] [cursor=pointer]:
                - img [ref=e31]
                - generic [ref=e34]: Shelf
              - button "Files" [ref=e35] [cursor=pointer]:
                - img [ref=e36]
                - generic [ref=e38]: Files
              - button "Terminal" [ref=e39] [cursor=pointer]:
                - img [ref=e40]
                - generic [ref=e43]: Terminal
          - navigation [ref=e44]:
            - generic [ref=e45]:
              - button "Daily Digest" [ref=e46] [cursor=pointer]:
                - img [ref=e47]
                - generic [ref=e50]: Daily Digest
              - button "Links" [ref=e52] [cursor=pointer]:
                - img [ref=e53]
                - generic [ref=e56]: Links
                - img [ref=e58]
            - region "Favorites" [ref=e60]:
              - button "Favorites" [expanded] [ref=e62] [cursor=pointer]:
                - img [ref=e63]
                - generic [ref=e65]: Favorites
              - list [ref=e66]:
                - listitem [ref=e67]:
                  - button "urgent-favorite 1 Options for urgent-favorite" [ref=e68] [cursor=pointer]:
                    - img [ref=e69]
                    - generic [ref=e72]: urgent-favorite
                    - generic [ref=e73]: "1"
                    - button "Options for urgent-favorite": ⋯
                - listitem [ref=e74]:
                  - button "VF Vera favorite" [ref=e75] [cursor=pointer]:
                    - generic [ref=e77]: VF
                    - generic [ref=e79]: Vera favorite
                - listitem [ref=e80]:
                  - button "Tango favorite Options for Tango favorite" [ref=e81] [cursor=pointer]:
                    - img [ref=e82]
                    - generic [ref=e85]: Tango favorite
                    - button "Options for Tango favorite": ⋯
                - listitem [ref=e86]:
                  - button "Sierra favorite Options for Sierra favorite" [ref=e87] [cursor=pointer]:
                    - img [ref=e88]
                    - generic [ref=e91]: Sierra favorite
                    - button "Options for Sierra favorite": ⋯
                - listitem [ref=e92]:
                  - button "RF Romeo favorite" [ref=e93] [cursor=pointer]:
                    - generic [ref=e95]: RF
                    - generic [ref=e97]: Romeo favorite
                - listitem [ref=e98]:
                  - button "zebra favorite Options for zebra favorite" [ref=e99] [cursor=pointer]:
                    - img [ref=e100]
                    - generic [ref=e103]: zebra favorite
                    - button "Options for zebra favorite": ⋯
                - listitem [ref=e104]:
                  - button "aardvark favorite Options for aardvark favorite" [ref=e105] [cursor=pointer]:
                    - img [ref=e106]
                    - generic [ref=e109]: aardvark favorite
                    - button "Options for aardvark favorite": ⋯
                - listitem [ref=e110]:
                  - button "Bravo favorite Options for Bravo favorite" [ref=e111] [cursor=pointer]:
                    - img [ref=e112]
                    - generic [ref=e115]: Bravo favorite
                    - button "Options for Bravo favorite": ⋯
                - listitem [ref=e116]:
                  - button "Show less" [expanded] [active] [ref=e117] [cursor=pointer]:
                    - img [ref=e118]
                    - generic [ref=e122]: Show less
            - region "Channels" [ref=e123]:
              - generic [ref=e124]:
                - button "Channels" [expanded] [ref=e125] [cursor=pointer]:
                  - img [ref=e126]
                  - generic [ref=e128]: Channels
                - button "New channel" [ref=e129] [cursor=pointer]:
                  - img [ref=e130]
              - list [ref=e131]:
                - listitem [ref=e132]:
                  - button "zulu-new 1 Options for zulu-new" [ref=e133] [cursor=pointer]:
                    - img [ref=e134]
                    - generic [ref=e137]: zulu-new
                    - generic [ref=e138]: "1"
                    - button "Options for zulu-new": ⋯
                - listitem [ref=e139]:
                  - button "alpha-old 1 Options for alpha-old" [ref=e140] [cursor=pointer]:
                    - img [ref=e141]
                    - generic [ref=e144]: alpha-old
                    - generic [ref=e145]: "1"
                    - button "Options for alpha-old": ⋯
                - listitem [ref=e146]:
                  - button "Violet Options for Violet" [ref=e147] [cursor=pointer]:
                    - img [ref=e148]
                    - generic [ref=e151]: Violet
                    - button "Options for Violet": ⋯
                - listitem [ref=e152]:
                  - button "tango Options for tango" [ref=e153] [cursor=pointer]:
                    - img [ref=e154]
                    - generic [ref=e157]: tango
                    - button "Options for tango": ⋯
                - listitem [ref=e158]:
                  - button "Sierra Options for Sierra" [ref=e159] [cursor=pointer]:
                    - img [ref=e160]
                    - generic [ref=e163]: Sierra
                    - button "Options for Sierra": ⋯
                - listitem [ref=e164]:
                  - button "romeo Options for romeo" [ref=e165] [cursor=pointer]:
                    - img [ref=e166]
                    - generic [ref=e169]: romeo
                    - button "Options for romeo": ⋯
                - listitem [ref=e170]:
                  - button "3 more" [ref=e171] [cursor=pointer]:
                    - img [ref=e172]
                    - generic [ref=e176]: 3 more
            - region "Direct messages" [ref=e177]:
              - generic [ref=e178]:
                - button "Direct messages" [expanded] [ref=e179] [cursor=pointer]:
                  - img [ref=e180]
                  - generic [ref=e182]: Direct messages
                - button "New direct message" [ref=e183] [cursor=pointer]:
                  - img [ref=e184]
              - list [ref=e185]:
                - listitem [ref=e186]:
                  - button "UQ Unread Quinn 1" [ref=e187] [cursor=pointer]:
                    - generic [ref=e189]: UQ
                    - generic [ref=e191]: Unread Quinn
                    - generic [ref=e193]: "1"
                - listitem [ref=e194]:
                  - button "V Vera" [ref=e195] [cursor=pointer]:
                    - generic [ref=e197]: V
                    - generic [ref=e199]: Vera
                - listitem [ref=e200]:
                  - button "U Uma" [ref=e201] [cursor=pointer]:
                    - generic [ref=e203]: U
                    - generic [ref=e205]: Uma
                - listitem [ref=e206]:
                  - button "T Theo" [ref=e207] [cursor=pointer]:
                    - generic [ref=e209]: T
                    - generic [ref=e211]: Theo
                - listitem [ref=e212]:
                  - button "S Sam" [ref=e213] [cursor=pointer]:
                    - generic [ref=e215]: S
                    - generic [ref=e217]: Sam
                - listitem [ref=e218]:
                  - button "Z Zoe" [ref=e219] [cursor=pointer]:
                    - generic [ref=e221]: Z
                    - generic [ref=e223]: Zoe
                - listitem [ref=e224]:
                  - button "2 more" [ref=e225] [cursor=pointer]:
                    - img [ref=e226]
                    - generic [ref=e230]: 2 more
          - 'button "Vitals: Claude and Codex usage" [ref=e232] [cursor=pointer]':
            - generic [ref=e233]:
              - generic [ref=e234]: Claude
              - generic [ref=e235]: 2 accounts
            - generic [ref=e239]: 55%
            - generic [ref=e240]: 45% free · both dry Sun 12:55 AM · +11h
            - generic [ref=e241]:
              - generic [ref=e243]: Codex
              - generic [ref=e246]: 0% used
              - generic [ref=e247]: 100% free · resets Fri 4:13 PM
      - separator "Resize channel sidebar" [ref=e248]
      - generic [ref=e250]:
        - main [ref=e251]:
          - generic [ref=e253]:
            - generic [ref=e254]:
              - generic [ref=e255]:
                - 'button "Filter inbox: All" [ref=e256] [cursor=pointer]':
                  - text: All
                  - img [ref=e257]
                - generic [ref=e259]: 10 items
              - list [ref=e261]:
                - listitem [ref=e262]:
                  - button "B Bella Bella 11:54 AM Activity in Bella" [ref=e263] [cursor=pointer]:
                    - generic [ref=e265]: B
                    - generic [ref=e266]:
                      - generic [ref=e267]:
                        - generic [ref=e268]: Bella
                        - generic [ref=e269]:
                          - img [ref=e270]
                          - generic [ref=e272]: Bella
                        - generic [ref=e273]: 11:54 AM
                      - paragraph [ref=e274]: Activity in Bella
                - listitem [ref=e275]:
                  - button "A aaron aaron 11:52 AM Activity in aaron" [ref=e276] [cursor=pointer]:
                    - generic [ref=e278]: A
                    - generic [ref=e279]:
                      - generic [ref=e280]:
                        - generic [ref=e281]: aaron
                        - generic [ref=e282]:
                          - img [ref=e283]
                          - generic [ref=e285]: aaron
                        - generic [ref=e286]: 11:52 AM
                      - paragraph [ref=e287]: Activity in aaron
                - listitem [ref=e288]:
                  - button "Z Zoe Zoe 11:51 AM Activity in Zoe" [ref=e289] [cursor=pointer]:
                    - generic [ref=e291]: Z
                    - generic [ref=e292]:
                      - generic [ref=e293]:
                        - generic [ref=e294]: Zoe
                        - generic [ref=e295]:
                          - img [ref=e296]
                          - generic [ref=e298]: Zoe
                        - generic [ref=e299]: 11:51 AM
                      - paragraph [ref=e300]: Activity in Zoe
                - listitem [ref=e301]:
                  - button "S Sam Sam 11:49 AM Activity in Sam" [ref=e302] [cursor=pointer]:
                    - generic [ref=e304]: S
                    - generic [ref=e305]:
                      - generic [ref=e306]:
                        - generic [ref=e307]: Sam
                        - generic [ref=e308]:
                          - img [ref=e309]
                          - generic [ref=e311]: Sam
                        - generic [ref=e312]: 11:49 AM
                      - paragraph [ref=e313]: Activity in Sam
                - listitem [ref=e314]:
                  - button "RF Romeo favorite Romeo favorite 11:49 AM Activity in Romeo favorite" [ref=e315] [cursor=pointer]:
                    - generic [ref=e317]: RF
                    - generic [ref=e318]:
                      - generic [ref=e319]:
                        - generic [ref=e320]: Romeo favorite
                        - generic [ref=e321]:
                          - img [ref=e322]
                          - generic [ref=e324]: Romeo favorite
                        - generic [ref=e325]: 11:49 AM
                      - paragraph [ref=e326]: Activity in Romeo favorite
                - listitem [ref=e327]:
                  - button "T Theo Theo 11:47 AM Activity in Theo" [ref=e328] [cursor=pointer]:
                    - generic [ref=e330]: T
                    - generic [ref=e331]:
                      - generic [ref=e332]:
                        - generic [ref=e333]: Theo
                        - generic [ref=e334]:
                          - img [ref=e335]
                          - generic [ref=e337]: Theo
                        - generic [ref=e338]: 11:47 AM
                      - paragraph [ref=e339]: Activity in Theo
                - listitem [ref=e340]:
                  - button "U Uma Uma 11:46 AM Activity in Uma" [ref=e341] [cursor=pointer]:
                    - generic [ref=e343]: U
                    - generic [ref=e344]:
                      - generic [ref=e345]:
                        - generic [ref=e346]: Uma
                        - generic [ref=e347]:
                          - img [ref=e348]
                          - generic [ref=e350]: Uma
                        - generic [ref=e351]: 11:46 AM
                      - paragraph [ref=e352]: Activity in Uma
                - listitem [ref=e353]:
                  - button "V Vera Vera 11:44 AM Activity in Vera" [ref=e354] [cursor=pointer]:
                    - generic [ref=e356]: V
                    - generic [ref=e357]:
                      - generic [ref=e358]:
                        - generic [ref=e359]: Vera
                        - generic [ref=e360]:
                          - img [ref=e361]
                          - generic [ref=e363]: Vera
                        - generic [ref=e364]: 11:44 AM
                      - paragraph [ref=e365]: Activity in Vera
                - listitem [ref=e366]:
                  - button "VF Vera favorite Vera favorite 11:44 AM Activity in Vera favorite" [ref=e367] [cursor=pointer]:
                    - generic [ref=e369]: VF
                    - generic [ref=e370]:
                      - generic [ref=e371]:
                        - generic [ref=e372]: Vera favorite
                        - generic [ref=e373]:
                          - img [ref=e374]
                          - generic [ref=e376]: Vera favorite
                        - generic [ref=e377]: 11:44 AM
                      - paragraph [ref=e378]: Activity in Vera favorite
                - listitem [ref=e379]:
                  - button "UQ Unread Quinn Unread Quinn 11:42 AM Activity in Unread Quinn" [ref=e380] [cursor=pointer]:
                    - generic [ref=e382]: UQ
                    - generic [ref=e384]:
                      - generic [ref=e385]:
                        - generic [ref=e386]: Unread Quinn
                        - generic [ref=e387]:
                          - img [ref=e388]
                          - generic [ref=e390]: Unread Quinn
                        - generic [ref=e391]: 11:42 AM
                      - paragraph [ref=e392]: Activity in Unread Quinn
            - generic [ref=e394]:
              - img [ref=e395]
              - paragraph [ref=e398]: Select a conversation to read it in context.
        - generic [ref=e399]:
          - separator "Resize side panel" [ref=e400]
          - generic [ref=e401]:
            - tablist "Side panel" [ref=e402]:
              - generic [ref=e403]:
                - tab "Work" [selected] [ref=e405] [cursor=pointer]
                - tab "Canvas" [ref=e407] [cursor=pointer]
            - complementary "Work" [ref=e410]:
              - generic [ref=e412]:
                - group "Scope" [ref=e413]:
                  - generic [ref=e414]: Scope
                  - button "Everywhere" [pressed] [ref=e415] [cursor=pointer]
                  - button "This channel" [disabled] [ref=e416]
                - button "Collapse Work" [ref=e417] [cursor=pointer]:
                  - img [ref=e418]
              - region "Needs you" [ref=e421]:
                - button "Needs you 0" [expanded] [ref=e422] [cursor=pointer]:
                  - img [ref=e423]
                  - text: Needs you
                  - generic [ref=e426]: "0"
                - paragraph [ref=e427]: Nothing needs you right now.
              - region "Running" [ref=e428]:
                - button "Running 0" [expanded] [ref=e429] [cursor=pointer]:
                  - img [ref=e430]
                  - text: Running
                  - generic [ref=e433]: "0"
                - paragraph [ref=e434]: No agents are working.
              - button "Done today 0" [ref=e435] [cursor=pointer]:
                - img [ref=e436]
                - img [ref=e438]
                - generic [ref=e440]: Done today
                - generic [ref=e441]: "0"
  - region "Notifications alt+T"
```

# Test source

```ts
  166 |   await expect(section.getByTestId("section-more")).toHaveText("Show less");
  167 |   await section.scrollIntoViewIfNeeded();
  168 |   await page.mouse.move(1_000, 100);
  169 |   await shot(page, `${screenshotName}-expanded`);
  170 |   return section.locator("ul > li > button[data-active] span.truncate");
  171 | }
  172 | 
  173 | // Local fallback is headed; CI retains its normal isolated browser.
  174 | test.use({
  175 |   viewport: { width: 1_440, height: 1_200 },
  176 |   headless: !!process.env.CI,
  177 | });
  178 | 
  179 | const consoleErrors = new WeakMap<Page, string[]>();
  180 | 
  181 | test.beforeEach(async ({ page }) => {
  182 |   const errors: string[] = [];
  183 |   consoleErrors.set(page, errors);
  184 |   page.on("console", (message) => {
  185 |     if (message.type() === "error") errors.push(message.text());
  186 |   });
  187 | });
  188 | 
  189 | test.describe("rendered sidebar order", () => {
  190 |   test.afterEach(async ({ page }, testInfo) => {
  191 |     await testInfo.attach("console-errors", {
  192 |       body: JSON.stringify(consoleErrors.get(page) ?? [], null, 2),
  193 |       contentType: "application/json",
  194 |     });
  195 |     await testInfo.attach("sidebar-state", {
  196 |       body: JSON.stringify(
  197 |         await page.evaluate(() => ({
  198 |           visits: localStorage.getItem("buzz.sidebar-visits.v1"),
  199 |           read: localStorage.getItem("buzz.read-state.v1"),
  200 |           favorites: localStorage.getItem("buzz.channel-prefs.v1"),
  201 |           pointerOverList: document.querySelector("nav:hover") !== null,
  202 |           sections: Array.from(
  203 |             document.querySelectorAll(
  204 |               '[data-testid="channel-sidebar"] section',
  205 |             ),
  206 |             (section) => ({
  207 |               name: section.getAttribute("aria-label"),
  208 |               labels: Array.from(
  209 |                 section.querySelectorAll(
  210 |                   "ul > li > button[data-active] span.truncate",
  211 |                 ),
  212 |                 (label) => label.textContent,
  213 |               ),
  214 |             }),
  215 |           ),
  216 |         })),
  217 |         null,
  218 |         2,
  219 |       ),
  220 |       contentType: "application/json",
  221 |     });
  222 |   });
  223 | 
  224 |   test("Channels: unread by recency, exactly four most used, then case-insensitive A-Z", async ({
  225 |     page,
  226 |   }) => {
  227 |     const errors = await seedSidebar(page);
  228 |     const rows = await sectionRows(page, "Channels", "channels");
  229 |     await expect(rows).toHaveText([
  230 |       "zulu-new",
  231 |       "alpha-old",
  232 |       "Violet",
  233 |       "tango",
  234 |       "Sierra",
  235 |       "romeo",
  236 |       "aardvark",
  237 |       "Bravo",
  238 |       "zebra",
  239 |     ]);
  240 |     expect(errors).toEqual([]);
  241 |   });
  242 | 
  243 |   test("Direct messages: unread, exactly four most used, then A-Z by displayed profile name", async ({
  244 |     page,
  245 |   }) => {
  246 |     const errors = await seedSidebar(page);
  247 |     const rows = await sectionRows(page, "Direct messages", "dms");
  248 |     await expect(rows).toHaveText([
  249 |       "Unread Quinn",
  250 |       "Vera",
  251 |       "Uma",
  252 |       "Theo",
  253 |       "Sam",
  254 |       "aaron",
  255 |       "Bella",
  256 |       "Zoe",
  257 |     ]);
  258 |     expect(errors).toEqual([]);
  259 |   });
  260 | 
  261 |   test("Favorites: mixed channels and DMs use unread, four most used, then A-Z", async ({
  262 |     page,
  263 |   }) => {
  264 |     const errors = await seedSidebar(page);
  265 |     const rows = await sectionRows(page, "Favorites", "favorites");
> 266 |     await expect(rows).toHaveText([
      |                        ^ Error: expect(locator).toHaveText(expected) failed
  267 |       "urgent-favorite",
  268 |       "Vera favorite",
  269 |       "Tango favorite",
  270 |       "Sierra favorite",
  271 |       "Romeo favorite",
  272 |       "aardvark favorite",
  273 |       "Bravo favorite",
  274 |       "zebra favorite",
  275 |     ]);
  276 |     expect(errors).toEqual([]);
  277 |   });
  278 | });
  279 | 
```