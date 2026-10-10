import type { HeadRotation } from './VisionVoiceControls';

interface Props {
  headRotation: HeadRotation | null;
}

export default function HolographicGlobe({ headRotation }: Props) {
  return (
    <div className="holographic-globe" aria-hidden="true">
      <div className="globe-atmosphere" />
      <svg className="globe-artwork" viewBox="0 0 600 600" role="presentation">
        <defs>
          <radialGradient id="globe-ocean" cx="36%" cy="31%" r="72%">
            <stop offset="0" stopColor="#85f7ff" stopOpacity=".84" />
            <stop offset=".18" stopColor="#138bd0" stopOpacity=".72" />
            <stop offset=".55" stopColor="#063e87" stopOpacity=".82" />
            <stop offset=".84" stopColor="#061d4d" stopOpacity=".96" />
            <stop offset="1" stopColor="#020a20" />
          </radialGradient>
          <radialGradient id="globe-limb">
            <stop offset=".76" stopColor="#56dcff" stopOpacity="0" />
            <stop offset=".9" stopColor="#4ccfff" stopOpacity=".12" />
            <stop offset=".97" stopColor="#a8f8ff" stopOpacity=".8" />
            <stop offset="1" stopColor="#45cfff" stopOpacity=".08" />
          </radialGradient>
          <linearGradient id="avatar-skin" x1="18%" y1="15%" x2="88%" y2="90%">
            <stop offset="0" stopColor="#ffe0c4" />
            <stop offset=".34" stopColor="#eab49b" />
            <stop offset=".72" stopColor="#c88678" />
            <stop offset="1" stopColor="#765d72" />
          </linearGradient>
          <linearGradient id="avatar-neck-shade" x1="0" y1="0" x2="1" y2=".6">
            <stop stopColor="#f3c2a4" />
            <stop offset=".54" stopColor="#d49381" />
            <stop offset="1" stopColor="#815e70" />
          </linearGradient>
          <linearGradient id="avatar-hair-shade" x1=".12" y1=".05" x2=".85" y2="1">
            <stop stopColor="#49637a" />
            <stop offset=".28" stopColor="#172b43" />
            <stop offset=".78" stopColor="#091526" />
            <stop offset="1" stopColor="#426379" />
          </linearGradient>
          <linearGradient id="avatar-clothing" x1=".1" y1="0" x2=".9" y2="1">
            <stop stopColor="#38788a" />
            <stop offset=".34" stopColor="#133c57" />
            <stop offset=".78" stopColor="#09233d" />
            <stop offset="1" stopColor="#52a1a9" />
          </linearGradient>
          <radialGradient id="avatar-cheek-light">
            <stop stopColor="#ffd4c2" stopOpacity=".68" />
            <stop offset="1" stopColor="#ee9e92" stopOpacity="0" />
          </radialGradient>
          <clipPath id="avatar-face-clip">
            <path d="M252 254Q253 222 300 218Q347 222 348 254L343 306Q339 340 300 354Q261 340 257 306Z" />
          </clipPath>
          <clipPath id="globe-clip">
            <circle cx="300" cy="300" r="246" />
          </clipPath>
        </defs>

        <circle className="globe-halo" cx="300" cy="300" r="258" />
        <circle cx="300" cy="300" r="246" fill="url(#globe-ocean)" />
        <g className="globe-surface" clipPath="url(#globe-clip)">
          <circle cx="300" cy="300" r="246" fill="url(#globe-limb)" />
          <g className="globe-land">
            <path d="m107 167 13-18 20-9 16-23 23-8 12-16 26 3 9 13 20 4 14 18-6 15-19 7-4 16 13 11-5 15-18 4-4 20-18 8-11 21-17 2-8-14-22-4-7-15-18-4-8-19-20-8zm74-33-3-23 15-16 16 5 7 18-11 18zm31 39 18-4 12 12-3 19-15 7-15-13z" />
            <path d="m224 264 17 7 9 18 15 8 2 22-12 19-2 26-13 29-5 35-13 27-12-19 4-27-11-23 6-27-9-21 9-20-5-20 10-16z" />
            <path d="m225 104 13-13 22 3 12 15-8 19-19 3-16-11z" />
            <path d="m290 164 8-13 18-4 10 8-6 13-18 5zm-3 30 13-8 17 6 8 18-11 11-19-4-12-12z" />
            <path d="m303 217 18-12 23 4 14 18 5 28-10 28-9 33-20 26-16-15-3-24-13-20 4-24-10-19 8-23z" />
            <path d="m342 151 15-14 26-5 18-13 31 6 13 15 28 4 13 18-14 13-25-4-11 14-19-3-7 17-18-5-15 12-15-8-14 5-9-17 10-14-7-13z" />
            <path d="m414 298 18-8 22 8 13 15 21 7-4 18-19 9-14-9-17 7-17-11-12-20z" />
            <path d="m424 365 18-12 22 7 13 18-9 20-23 8-20-14z" />
          </g>
          <path className="avatar-lashes" d="M267 285l-3-3m8 1-1-4m8 4 1-4m33 3 1-4m8 4 2-4m5 5 3-3" />
          <g className="globe-graticule">
            <ellipse cx="300" cy="300" rx="244" ry="58" />
            <ellipse cx="300" cy="300" rx="244" ry="116" />
            <ellipse cx="300" cy="300" rx="244" ry="176" />
            <ellipse cx="300" cy="300" rx="244" ry="220" />
            <ellipse cx="300" cy="300" rx="68" ry="244" />
            <ellipse cx="300" cy="300" rx="132" ry="244" />
            <ellipse cx="300" cy="300" rx="192" ry="244" />
            <path d="M54 300h492M73 210h454M73 390h454M124 127h352M124 473h352" />
          </g>
          <g className="globe-coastlines">
            <path d="m117 181 31-21 22 4 8 15 29 6 13 19-9 17-22 8-7 28-17 7-7-25-22-11-7-25-24-12z" />
            <path d="m263 284 25-15 23 7 15 16 23 6 17 23-9 20-24 8-8 24-18 10-10-19-20-11-11-22 11-18-21-11z" />
            <path d="m398 158 25-9 21 13 4 23-16 11-20-8-14-16z" />
          </g>
          <path className="globe-shine" d="M70 220Q300 91 530 220v34Q300 137 70 254z" />
        </g>
        <g className="holo-avatar" aria-hidden="true">
          <g className="avatar-body">
            <path className="avatar-bust" d="M205 442Q209 390 245 379L275 369H325L355 379Q391 390 395 442Z" />
            <path className="avatar-neck" d="M278 340V378Q300 394 322 378V340Z" />
            <path className="avatar-shoulder-light" d="M223 430Q234 393 269 386L300 409 331 386Q367 393 378 430" />
            <path className="avatar-collar" d="m267 379 33 30 33-30m-33 30v19" />
            <circle className="avatar-pendant" cx="300" cy="414" r="3.2" />
          </g>
          <g
            className="avatar-head-tracker"
            style={{
              transform: `translate(${(headRotation?.yaw ?? 0) * 0.25}px, ${(headRotation?.pitch ?? 0) * 0.25}px) rotate(${headRotation?.roll ?? 0}deg)`
            }}
          >
          <g className="avatar-head">
            <path className="avatar-ear" d="M250 276Q232 270 237 296Q240 309 254 310M350 276Q368 270 363 296Q360 309 346 310" />
            <path className="avatar-hair-back" d="M250 275Q233 244 250 220Q266 197 301 202Q340 201 355 230Q367 253 350 280L359 367Q345 363 338 339L340 281Q331 270 328 249Q306 258 272 248Q262 262 252 278L259 337Q256 359 242 367Z" />
            <path className="avatar-face" d="M252 254Q253 222 300 218Q347 222 348 254L343 306Q339 340 300 354Q261 340 257 306Z" />
            <g className="avatar-face-depth" clipPath="url(#avatar-face-clip)">
              <ellipse cx="276" cy="300" rx="21" ry="14" />
              <ellipse cx="324" cy="300" rx="21" ry="14" />
              <path className="avatar-face-shadow" d="M326 220Q354 245 343 306Q337 343 300 355Q327 329 326 292Z" />
              <path className="avatar-nose-light" d="M298 270Q296 294 289 310Q295 316 302 313" />
            </g>
            <path className="avatar-hair" d="M248 276Q240 244 257 221Q274 202 303 208Q339 204 352 235Q358 254 350 278Q342 263 337 247Q325 263 308 266Q291 265 284 251Q270 269 248 276Z" />
            <path className="avatar-hair-fringe" d="M249 265Q266 251 275 232Q279 251 291 258Q305 265 321 253Q333 247 339 237Q353 253 350 275Q340 264 335 251Q324 269 306 271Q290 268 282 256Q269 274 250 279Z" />
            <path className="avatar-hair-glint" d="M261 242Q276 213 306 216Q331 214 343 235" />
            <path className="avatar-hairline" d="M250 267Q258 250 269 241M350 267Q342 250 331 241" />
            <circle className="avatar-earring" cx="245" cy="307" r="3" />
            <circle className="avatar-earring" cx="355" cy="307" r="3" />
            <path className="avatar-brow" d="M266 275Q278 269 289 275M311 275Q322 269 334 275" />
            <g className="avatar-eyes">
              <g className="avatar-eye">
                <ellipse className="avatar-eye-white" cx="278" cy="290" rx="9" ry="6.5" />
                <circle className="avatar-iris" cx="280" cy="290" r="4.1" />
                <circle className="avatar-pupil" cx="281" cy="290" r="2" />
                <circle className="avatar-eye-light" cx="282" cy="288.5" r="1" />
              </g>
              <g className="avatar-eye">
                <ellipse className="avatar-eye-white" cx="322" cy="290" rx="9" ry="6.5" />
                <circle className="avatar-iris" cx="320" cy="290" r="4.1" />
                <circle className="avatar-pupil" cx="319" cy="290" r="2" />
                <circle className="avatar-eye-light" cx="320" cy="288.5" r="1" />
              </g>
            </g>
            <path className="avatar-nose" d="M300 287L295 310Q300 314 305 310" />
            <path className="avatar-cheek" d="M264 312Q277 318 287 313M313 313Q323 318 336 312" />
            <path className="avatar-lips" d="M287 326Q300 321 313 326Q300 338 287 326Z" />
            <path className="avatar-mouth" d="M286 326Q300 337 314 326" />
            <path className="avatar-expression-smile" d="M285 324Q300 341 315 324" />
            <path className="avatar-expression-concern" d="M286 333Q300 319 314 333" />
            <ellipse className="avatar-mouth-open" cx="300" cy="329" rx="8" ry="2" />
            <path className="avatar-face-glint" d="M263 257Q274 232 297 229" />
          </g>
          </g>
          <g className="avatar-signal">
            <circle cx="300" cy="414" r="3" />
            <path d="M290 414a10 10 0 0 1 20 0M283 414a17 17 0 0 1 34 0" />
          </g>
        </g>
        <circle className="globe-outline" cx="300" cy="300" r="246" />
        <ellipse className="globe-orbit orbit-a" cx="300" cy="300" rx="287" ry="98" />
        <ellipse className="globe-orbit orbit-b" cx="300" cy="300" rx="98" ry="286" />
        <ellipse className="globe-orbit orbit-c" cx="300" cy="300" rx="278" ry="175" />
        <ellipse className="globe-orbit orbit-d" cx="300" cy="300" rx="264" ry="126" />
        <ellipse className="globe-orbit orbit-e" cx="300" cy="300" rx="294" ry="232" />
        <circle className="globe-hud-ring" cx="300" cy="300" r="276" />
        <g className="orbit-particle-track orbit-track-a"><circle cx="300" cy="202" r="3" /></g>
        <g className="orbit-particle-track orbit-track-b"><circle cx="398" cy="300" r="2.5" /></g>
        <g className="orbit-particle-track orbit-track-c"><circle cx="300" cy="125" r="2" /></g>
        <g className="orbit-particle-track orbit-track-d"><circle cx="300" cy="174" r="2.5" /></g>
        <g className="globe-hud-ticks">
          <path d="M300 14v15m0 542v15M14 300h15m542 0h15M98 98l11 11m382 382 11 11M502 98l-11 11M109 491l-11 11" />
          <circle cx="300" cy="24" r="3" />
          <circle cx="576" cy="300" r="3" />
          <circle cx="300" cy="576" r="3" />
          <circle cx="24" cy="300" r="3" />
        </g>
        <g className="globe-particles">
          <circle cx="82" cy="247" r="2" />
          <circle cx="493" cy="152" r="2" />
          <circle cx="464" cy="455" r="2" />
          <circle cx="154" cy="478" r="2" />
          <circle cx="540" cy="356" r="1.5" />
          <circle cx="114" cy="382" r="1.5" />
        </g>
        <path className="globe-scan-line" d="M62 286h476" />
      </svg>
    </div>
  );
}
