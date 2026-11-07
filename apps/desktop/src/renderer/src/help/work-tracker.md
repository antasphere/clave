# Work Tracker

A sidebar widget that tracks your daily work time, streaks, and weekly trends across all Claude sessions.

## What It Shows

- **Today's time**: Active work time accumulated across all sessions today
- **Session count**: Number of Claude sessions you've used today
- **Current streak**: How long you've been working without a break
- **Break reminders**: Visual color changes when you've been working a long stretch (green to amber to red)
- **Yesterday summary**: How much you worked yesterday for comparison
- **Weekly chart**: Bar chart of daily work time for the past 7 days

## How It Works

The widget appears in the sidebar footer once you start your first session of the day. It has two states:

- **Collapsed**: Compact view showing today's time and a session count. Click to expand.
- **Expanded**: Full stats panel with today's breakdown by project, streak, and weekly chart.

Only active work time counts. If Claude is idle or waiting, the timer pauses.

## Break Reminders

The widget changes color based on your current streak duration:

- **Green**: Normal, under 2 hours
- **Amber**: Gentle reminder after 2 hours
- **Red**: Strong reminder after 4 hours

A 15-minute break resets the streak.

## Settings

Toggle the widget on or off in **Settings**. The preference persists across restarts.

## Data Source

Today's time is tracked live from your active sessions. Historical data (yesterday, weekly) comes from Claude Code's session files. All analysis happens locally.
