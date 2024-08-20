import { InvsyServer } from 'invsy';
import type {Env} from "./server";
import {userId} from "./shared";

export const invsy = (env: Env) => new InvsyServer(
    env.INVSY_API_KEY,
    env.INVSY_PROJECT_ID,
    userId
)